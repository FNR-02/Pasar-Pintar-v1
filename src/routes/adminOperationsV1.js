const express = require('express');

const pool = require('../config/db');
const {
    verifyToken,
    requireRole
} = require('../middleware/auth');

const router = express.Router();

const AdminPaymentRecoveryService =
    require(
        '../services/payments/AdminPaymentRecoveryService'
    );

const AdminStaleOrderCancellationService =
    require(
        '../services/orders/AdminStaleOrderCancellationService'
    );

const adminPaymentRecoveryService =
    new AdminPaymentRecoveryService(pool);

const adminStaleOrderCancellationService =
    new AdminStaleOrderCancellationService(
        pool
    );

const EXCEPTION_PRIORITY = {
    /*
     * Hard logistics consistency failures.
     *
     * Hanya berlaku setelah lifecycle sudah
     * mewajibkan shipment.
     */
    DELIVERY_STATUS_MISMATCH: 150,
    SHIPMENT_ORDER_STATUS_MISMATCH: 145,
    DELIVERY_DISPATCHED_NO_SHIPMENT: 140,
    DELIVERY_INVALID_COURIER: 135,
    DELIVERY_NO_TRACKING: 130,

    DELIVERY_NO_ADDRESS: 100,
    FAILED_PAYMENT: 90,
    UNPAID_PAYMENT: 80,
    NO_PAYMENT: 70,
    STALE_PACKING_72H: 65,
    STALE_PENDING_72H: 60,
    STALE_PENDING_24H: 50
};

function classifyOrderExceptions(
    row,
    nowMs = Date.now()
) {
    const codes = [];

    const orderStatus =
        String(
            row.status || ''
        ).toUpperCase();

    const fulfillmentType =
        String(
            row.fulfillment_type || ''
        ).toUpperCase();

    const paymentMode =
        String(
            row.payment_mode || 'DIRECT'
        ).toUpperCase();

    const paymentStatus =
        row.payment_status === null ||
        row.payment_status === undefined
            ? ''
            : String(
                row.payment_status
            ).toUpperCase();

    const createdAtMs =
        new Date(
            row.created_at
        ).getTime();

    const pendingAgeHours =
        orderStatus === 'PENDING' &&
        Number.isFinite(createdAtMs)
            ? Math.max(
                0,
                (
                    nowMs -
                    createdAtMs
                ) / 3600000
            )
            : null;

    /*
     * PACKING adalah state sesudah payment /
     * fulfillment berhasil.
     *
     * Shipment belum wajib pada state ini:
     * - DELIVERY membuat shipment + courier saat
     *   PACKING -> DISPATCHED.
     * - PICKUP memakai DISPATCHED sebagai
     *   siap diambil tanpa shipment.
     *
     * Jadi exception ini mengukur stagnasi proses
     * merchant, bukan kehilangan shipment.
     */
    const packingAgeHours =
        orderStatus === 'PACKING' &&
        Number.isFinite(createdAtMs)
            ? Math.max(
                0,
                (
                    nowMs -
                    createdAtMs
                ) / 3600000
            )
            : null;

    if (
        orderStatus === 'PENDING' &&
        fulfillmentType === 'DELIVERY' &&
        !String(
            row.shipping_address || ''
        ).trim()
    ) {
        codes.push(
            'DELIVERY_NO_ADDRESS'
        );
    }

    /*
     * Payment exceptions hanya berlaku untuk
     * DIRECT PENDING orders.
     *
     * TEMPO memiliki financial lifecycle sendiri
     * melalui credit obligations.
     */
    if (
        orderStatus === 'PENDING' &&
        paymentMode !== 'TEMPO'
    ) {
        if (
            paymentStatus === 'FAILED'
        ) {
            codes.push(
                'FAILED_PAYMENT'
            );

        } else if (
            paymentStatus === 'UNPAID' ||
            paymentStatus === 'PENDING'
        ) {
            codes.push(
                'UNPAID_PAYMENT'
            );

        } else if (
            !paymentStatus
        ) {
            codes.push(
                'NO_PAYMENT'
            );
        }
    }

    /*
     * STALE PACKING V1
     *
     * 72 jam dipilih sebagai operational-attention
     * boundary agar tidak menandai packing normal.
     *
     * Read-only exception:
     * tidak mengubah order, payment, inventory,
     * shipment, atau courier.
     */
    if (
        orderStatus === 'PACKING' &&
        packingAgeHours !== null &&
        packingAgeHours >= 72
    ) {
        codes.push(
            'STALE_PACKING_72H'
        );
    }

    if (
        orderStatus === 'PENDING' &&
        pendingAgeHours !== null
    ) {
        if (
            pendingAgeHours >= 72
        ) {
            codes.push(
                'STALE_PENDING_72H'
            );

        } else if (
            pendingAgeHours >= 24
        ) {
            codes.push(
                'STALE_PENDING_24H'
            );
        }
    }

    /*
     * =========================================================
     * LOGISTICS CONSISTENCY V1
     * =========================================================
     *
     * Shipment belum diwajibkan ketika:
     * - PENDING
     * - PAID
     * - PACKING
     *
     * PICKUP juga tidak memakai shipment.
     *
     * Hard logistics consistency baru berlaku setelah
     * DELIVERY memasuki DISPATCHED / DELIVERED lifecycle.
     */

    const shipmentId =
        row.shipment_id || null;

    const shipmentStatus =
        String(
            row.shipping_status || ''
        ).toUpperCase();

    const courierId =
        row.courier_id || null;

    const courierUserId =
        row.courier_user_id || null;

    const courierRole =
        Number(
            row.courier_role
        );

    const trackingNumber =
        String(
            row.tracking_number || ''
        ).trim();

    const advancedDelivery =
        fulfillmentType === 'DELIVERY' &&
        (
            orderStatus === 'DISPATCHED' ||
            orderStatus === 'DELIVERED'
        );

    /*
     * PACKING -> DISPATCHED DELIVERY secara canonical
     * membuat shipment dalam transaction yang sama.
     */
    if (
        fulfillmentType === 'DELIVERY' &&
        orderStatus === 'DISPATCHED' &&
        !shipmentId
    ) {
        codes.push(
            'DELIVERY_DISPATCHED_NO_SHIPMENT'
        );
    }

    /*
     * Setelah shipment wajib, courier harus resolve ke
     * canonical role-3 tbl_users identity.
     */
    if (
        advancedDelivery &&
        shipmentId &&
        (
            !courierId ||
            !courierUserId ||
            courierRole !== 3
        )
    ) {
        codes.push(
            'DELIVERY_INVALID_COURIER'
        );
    }

    /*
     * Tracking dibuat saat canonical dispatch.
     */
    if (
        advancedDelivery &&
        shipmentId &&
        !trackingNumber
    ) {
        codes.push(
            'DELIVERY_NO_TRACKING'
        );
    }

    /*
     * DELIVERY order DELIVERED wajib mempunyai
     * shipment DELIVERED.
     */
    if (
        fulfillmentType === 'DELIVERY' &&
        orderStatus === 'DELIVERED' &&
        (
            !shipmentId ||
            shipmentStatus !== 'DELIVERED'
        )
    ) {
        codes.push(
            'DELIVERY_STATUS_MISMATCH'
        );
    }

    /*
     * Reverse consistency:
     * shipment tidak boleh DELIVERED sementara order
     * masih berada di state lain.
     */
    if (
        shipmentId &&
        shipmentStatus === 'DELIVERED' &&
        orderStatus !== 'DELIVERED'
    ) {
        codes.push(
            'SHIPMENT_ORDER_STATUS_MISMATCH'
        );
    }

    const orderedCodes =
        [...new Set(codes)]
            .sort(
                (a, b) =>
                    (
                        EXCEPTION_PRIORITY[b] ||
                        0
                    ) -
                    (
                        EXCEPTION_PRIORITY[a] ||
                        0
                    )
            );

    const primary =
        orderedCodes[0] ||
        null;

    return {
        exception_codes:
            orderedCodes,

        exception_primary:
            primary,

        exception_priority:
            primary
                ? EXCEPTION_PRIORITY[
                    primary
                ] || 0
                : 0,

        pending_age_hours:
            pendingAgeHours === null
                ? null
                : Math.round(
                    pendingAgeHours *
                    10
                ) / 10
    };
}

/*
 * ADMIN OPERATIONS V1
 *
 * Read-only operational control surface.
 *
 * Canonical domains:
 * - Orders      : tbl_orders_v2
 * - Payments    : tbl_payments
 * - Shipments   : tbl_shipments
 * - Inventory   : tbl_inventory
 * - Tempo       : tbl_credit_obligations
 *
 * Admin only.
 */

router.get(
    '/admin/operations/v1',
    verifyToken,
    requireRole(4),
    async (req, res) => {
        try {
            /*
             * ORDER OPERATIONS
             *
             * Payment projection mengikuti canonical order readers:
             * payment terbaru untuk setiap order.
             */
            const ordersResult = await pool.query(`
                SELECT
                    o.id,
                    o.status,
                    o.fulfillment_type,
                    o.payment_mode,
                    o.total_amount,
                    o.shipping_address,
                    o.pickup_location_snapshot,
                    o.tempo_due_at,
                    o.created_at,

                    c.id AS customer_id,
                    c.full_name AS customer_name,
                    c.phone AS customer_phone,

                    m.id AS merchant_id,
                    m.store_name AS merchant_name,
                    m.phone AS merchant_phone,

                    pay.provider AS payment_provider,
                    pay.payment_method,
                    pay.payment_status,
                    pay.payment_amount,

                    s.id AS shipment_id,
                    s.shipping_status,
                    s.tracking_number,
                    s.courier_id,
                    s.updated_at AS shipment_updated_at,

                    cu.id AS courier_user_id,
                    cu.role_id AS courier_role,

                    COALESCE(
                        NULLIF(
                            BTRIM(cr.full_name),
                            ''
                        ),
                        cu.username
                    ) AS courier_name,
                    cr.phone AS courier_phone

                FROM tbl_orders_v2 o

                LEFT JOIN tbl_customers c
                    ON c.id = o.customer_id

                LEFT JOIN tbl_merchants m
                    ON m.id = o.merchant_id

                LEFT JOIN LATERAL (
                    SELECT
                        pmt.provider,
                        pmt.payment_method,
                        pmt.payment_status,
                        pmt.amount AS payment_amount
                    FROM tbl_payments pmt
                    WHERE pmt.order_id = o.id
                    ORDER BY
                        pmt.created_at DESC,
                        pmt.id DESC
                    LIMIT 1
                ) pay ON TRUE

                LEFT JOIN LATERAL (
                    SELECT
                        sh.id,
                        sh.shipping_status,
                        sh.tracking_number,
                        sh.courier_id,
                        sh.updated_at
                    FROM tbl_shipments sh
                    WHERE sh.order_id = o.id
                    ORDER BY
                        sh.updated_at DESC,
                        sh.id DESC
                    LIMIT 1
                ) s ON TRUE

                LEFT JOIN tbl_users cu
                    ON cu.id = s.courier_id

                LEFT JOIN tbl_couriers cr
                    ON cr.user_id = s.courier_id

                ORDER BY o.created_at DESC

                LIMIT 100
            `);

            /*
             * INVENTORY ATTENTION
             *
             * quantity_on_hand <= min_stock_level
             * merupakan canonical low-stock boundary.
             */
            const lowStockResult = await pool.query(`
                SELECT
                    i.id AS inventory_id,
                    i.product_id,
                    p.name AS product_name,
                    p.sku,
                    p.selling_unit,
                    p.merchant_id,
                    m.store_name AS merchant_name,

                    i.warehouse_id,
                    w.warehouse_name,
                    w.location AS warehouse_location,

                    i.quantity_on_hand,
                    i.min_stock_level,
                    i.max_stock_level,
                    i.updated_at

                FROM tbl_inventory i

                JOIN tbl_products p
                    ON p.id = i.product_id

                LEFT JOIN tbl_merchants m
                    ON m.id = p.merchant_id

                JOIN tbl_warehouses w
                    ON w.id = i.warehouse_id

                WHERE
                    i.quantity_on_hand <= i.min_stock_level

                ORDER BY
                    i.quantity_on_hand ASC,
                    i.updated_at DESC

                LIMIT 100
            `);

            /*
             * TEMPO ATTENTION
             *
             * tbl_credit_obligations adalah sumber kewajiban.
             * tbl_payments tidak digunakan untuk settlement tempo.
             *
             * Attention:
             * - obligation belum lunas
             * - outstanding > 0
             * - jatuh tempo <= 3 hari ke depan
             *
             * Ini mencakup:
             * OVERDUE + DUE_SOON.
             */
            const tempoResult = await pool.query(`
                SELECT
                    co.id AS obligation_id,
                    co.credit_account_id,
                    ca.account_type,

                    ca.customer_id,
                    c.full_name AS customer_name,
                    c.phone AS customer_phone,

                    ca.merchant_id,
                    m.store_name AS merchant_name,
                    m.phone AS merchant_phone,

                    ca.supplier_id,

                    co.source_type,
                    co.source_id,

                    co.principal_amount,
                    co.paid_amount,

                    GREATEST(
                        co.principal_amount - co.paid_amount,
                        0
                    ) AS outstanding_amount,

                    co.due_at,
                    co.status,
                    co.description,
                    co.opened_at,

                    CASE
                        WHEN co.due_at < NOW()
                            THEN 'OVERDUE'
                        ELSE 'DUE_SOON'
                    END AS attention_type

                FROM tbl_credit_obligations co

                JOIN tbl_credit_accounts ca
                    ON ca.id = co.credit_account_id

                LEFT JOIN tbl_customers c
                    ON c.id = ca.customer_id

                LEFT JOIN tbl_merchants m
                    ON m.id = ca.merchant_id

                WHERE
                    co.principal_amount > co.paid_amount
                    AND UPPER(co.status) <> 'PAID'
                    AND co.due_at <= NOW() + INTERVAL '3 days'

                ORDER BY
                    CASE
                        WHEN co.due_at < NOW() THEN 0
                        ELSE 1
                    END,
                    co.due_at ASC

                LIMIT 100
            `);

            /*
             * Lightweight operational summary.
             */
            const summaryResult = await pool.query(`
                SELECT
                    (
                        SELECT COUNT(*)::int
                        FROM tbl_orders_v2
                    ) AS total_orders,

                    (
                        SELECT COUNT(*)::int
                        FROM tbl_orders_v2
                        WHERE status NOT IN (
                            'DELIVERED',
                            'CANCELLED'
                        )
                    ) AS open_orders,

                    (
                        SELECT COUNT(*)::int
                        FROM tbl_payments
                        WHERE payment_status = 'UNPAID'
                    ) AS unpaid_payments,

                    (
                        SELECT COUNT(*)::int
                        FROM tbl_inventory
                        WHERE quantity_on_hand <= min_stock_level
                    ) AS low_stock_items,

                    (
                        SELECT COUNT(*)::int
                        FROM tbl_credit_obligations
                        WHERE
                            principal_amount > paid_amount
                            AND UPPER(status) <> 'PAID'
                            AND due_at < NOW()
                    ) AS overdue_tempo,

                    (
                        SELECT COUNT(*)::int
                        FROM tbl_shipments
                        WHERE shipping_status <> 'DELIVERED'
                    ) AS active_shipments
            `);

            const generatedAt =
                new Date();

            const orders =
                ordersResult.rows.map(
                    row => ({
                        ...row,
                        ...classifyOrderExceptions(
                            row,
                            generatedAt.getTime()
                        )
                    })
                );

            const exceptionSummary = {
                exception_orders:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .length > 0
                    ).length,

                failed_payment:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .includes(
                                    'FAILED_PAYMENT'
                                )
                    ).length,

                unpaid_payment:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .includes(
                                    'UNPAID_PAYMENT'
                                )
                    ).length,

                no_payment:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .includes(
                                    'NO_PAYMENT'
                                )
                    ).length,

                delivery_no_address:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .includes(
                                    'DELIVERY_NO_ADDRESS'
                                )
                    ).length,

                stale_packing_72h:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .includes(
                                    'STALE_PACKING_72H'
                                )
                    ).length,

                delivery_dispatched_no_shipment:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .includes(
                                    'DELIVERY_DISPATCHED_NO_SHIPMENT'
                                )
                    ).length,

                delivery_invalid_courier:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .includes(
                                    'DELIVERY_INVALID_COURIER'
                                )
                    ).length,

                delivery_no_tracking:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .includes(
                                    'DELIVERY_NO_TRACKING'
                                )
                    ).length,

                delivery_status_mismatch:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .includes(
                                    'DELIVERY_STATUS_MISMATCH'
                                )
                    ).length,

                shipment_order_status_mismatch:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .includes(
                                    'SHIPMENT_ORDER_STATUS_MISMATCH'
                                )
                    ).length,

                logistics_consistency_orders:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .some(
                                    code =>
                                        [
                                            'DELIVERY_DISPATCHED_NO_SHIPMENT',
                                            'DELIVERY_INVALID_COURIER',
                                            'DELIVERY_NO_TRACKING',
                                            'DELIVERY_STATUS_MISMATCH',
                                            'SHIPMENT_ORDER_STATUS_MISMATCH'
                                        ].includes(
                                            code
                                        )
                                )
                    ).length,

                stale_pending_24h:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .includes(
                                    'STALE_PENDING_24H'
                                ) ||
                            row.exception_codes
                                .includes(
                                    'STALE_PENDING_72H'
                                )
                    ).length,

                stale_pending_72h:
                    orders.filter(
                        row =>
                            row.exception_codes
                                .includes(
                                    'STALE_PENDING_72H'
                                )
                    ).length
            };

            return res.json({
                status: 'success',

                generated_at:
                    generatedAt.toISOString(),

                summary: {
                    ...summaryResult.rows[0],
                    ...exceptionSummary
                },

                orders,

                attention: {
                    low_stock:
                        lowStockResult.rows,

                    tempo:
                        tempoResult.rows
                }
            });

        } catch (err) {
            console.error(
                '[ADMIN OPERATIONS V1]',
                err.message
            );

            return res.status(500).json({
                status: 'error',
                error: err.message
            });
        }
    }
);


/*
 * ============================================================
 * ADMIN PAYMENT RECOVERY V1
 *
 * Narrow operational recovery only.
 *
 * BUKAN:
 * - generic order status override
 * - manual PAID override
 * - refund
 * - TEMPO mutation
 *
 * Domain policy tetap dimiliki
 * AdminPaymentRecoveryService.
 * ============================================================
 */
router.post(
    '/admin/operations/v1/orders/:orderId/recover-payment',
    verifyToken,
    requireRole(4),
    async (req, res) => {
        const { orderId } =
            req.params;

        const {
            provider,
            payment_method,
            channel = null
        } = req.body || {};

        if (
            !provider ||
            !payment_method
        ) {
            return res.status(400).json({
                status: 'error',
                code:
                    'RECOVERY_INPUT_REQUIRED',
                error:
                    'provider dan payment_method wajib diisi'
            });
        }

        try {
            const result =
                await adminPaymentRecoveryService
                    .recover({
                        orderId,
                        adminUserId:
                            req.user.id,
                        provider,
                        paymentMethod:
                            payment_method,
                        channel
                    });

            switch (result.status) {
            case 'success':
                return res.status(200).json({
                    status: 'success',
                    message:
                        'Recovery pembayaran berhasil',
                    recovery:
                        result
                });

            case 'invalid_input':
                return res.status(400).json({
                    status: 'error',
                    code:
                        'RECOVERY_INVALID_INPUT',
                    recovery:
                        result
                });

            case 'order_not_found':
                return res.status(404).json({
                    status: 'error',
                    code:
                        'RECOVERY_ORDER_NOT_FOUND',
                    recovery:
                        result
                });

            case 'order_not_pending':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'RECOVERY_ORDER_NOT_PENDING',
                    recovery:
                        result
                });

            case 'tempo_not_allowed':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'RECOVERY_TEMPO_NOT_ALLOWED',
                    recovery:
                        result
                });

            case 'delivery_address_required':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'RECOVERY_DELIVERY_ADDRESS_REQUIRED',
                    recovery:
                        result
                });

            case 'already_paid':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'RECOVERY_ALREADY_PAID',
                    recovery:
                        result
                });

            case 'active_payment_exists':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'RECOVERY_ACTIVE_PAYMENT_EXISTS',
                    recovery:
                        result
                });

            case 'expired_payment_requires_explicit_retry':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'RECOVERY_EXPIRED_PAYMENT_REQUIRES_EXPLICIT_RETRY',
                    recovery:
                        result
                });

            case 'payment_state_not_recoverable':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'RECOVERY_PAYMENT_STATE_NOT_RECOVERABLE',
                    recovery:
                        result
                });

            case 'payment_recovery_rejected':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'RECOVERY_PAYMENT_REJECTED',
                    recovery:
                        result
                });

            default:
                return res.status(409).json({
                    status: 'error',
                    code:
                        'RECOVERY_NOT_COMPLETED',
                    recovery:
                        result
                });
            }

        } catch (err) {
            console.error(
                '[ADMIN PAYMENT RECOVERY V1]',
                err.message
            );

            return res.status(400).json({
                status: 'error',
                code:
                    'RECOVERY_FAILED',
                error:
                    err.message
            });
        }
    }
);


/*
 * ============================================================
 * ADMIN ORDER SHIPPING ADDRESS CORRECTION V1
 * ============================================================
 *
 * Narrow operational repair only.
 *
 * Policy:
 * - role 4 only
 * - tbl_orders_v2 only
 * - order harus PENDING
 * - fulfillment harus DELIVERY
 * - shipping_address wajib non-empty
 * - maximum 1000 karakter
 * - tidak mengubah customer default_address
 * - tidak mengubah payment
 * - tidak mengubah inventory/reservation
 * - tidak mengubah fulfillment
 * - tidak mengubah order status
 * ============================================================
 */
router.patch(
    '/admin/operations/v1/orders/:orderId/shipping-address',
    verifyToken,
    requireRole(4),
    async (req, res) => {
        const { orderId } =
            req.params;

        const shippingAddress =
            String(
                req.body?.shipping_address || ''
            ).trim();

        if (!shippingAddress) {
            return res.status(400).json({
                status: 'error',
                code:
                    'SHIPPING_ADDRESS_REQUIRED',
                error:
                    'Alamat pengiriman wajib diisi'
            });
        }

        if (shippingAddress.length > 1000) {
            return res.status(400).json({
                status: 'error',
                code:
                    'SHIPPING_ADDRESS_TOO_LONG',
                error:
                    'Alamat pengiriman maksimal 1000 karakter'
            });
        }

        const client =
            await pool.connect();

        try {
            await client.query('BEGIN');

            const orderResult =
                await client.query(
                    `
                    SELECT
                        id,
                        status,
                        fulfillment_type,
                        shipping_address
                    FROM tbl_orders_v2
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [orderId]
                );

            if (!orderResult.rowCount) {
                await client.query(
                    'ROLLBACK'
                );

                return res.status(404).json({
                    status: 'error',
                    code:
                        'ADDRESS_ORDER_NOT_FOUND'
                });
            }

            const order =
                orderResult.rows[0];

            if (
                String(
                    order.status || ''
                ).toUpperCase() !==
                'PENDING'
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res.status(409).json({
                    status: 'error',
                    code:
                        'ADDRESS_ORDER_NOT_PENDING',
                    current_status:
                        order.status
                });
            }

            if (
                String(
                    order.fulfillment_type || ''
                ).toUpperCase() !==
                'DELIVERY'
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res.status(409).json({
                    status: 'error',
                    code:
                        'ADDRESS_DELIVERY_ONLY',
                    fulfillment_type:
                        order.fulfillment_type
                });
            }

            const updatedResult =
                await client.query(
                    `
                    UPDATE tbl_orders_v2
                    SET
                        shipping_address = $2
                    WHERE id = $1
                    RETURNING
                        id,
                        status,
                        fulfillment_type,
                        shipping_address
                    `,
                    [
                        order.id,
                        shippingAddress
                    ]
                );

            await client.query('COMMIT');

            return res.status(200).json({
                status: 'success',
                message:
                    'Alamat pengiriman berhasil diperbarui',
                order:
                    updatedResult.rows[0]
            });

        } catch (err) {
            try {
                await client.query(
                    'ROLLBACK'
                );
            } catch (_) {}

            console.error(
                '[ADMIN SHIPPING ADDRESS V1]',
                err.message
            );

            return res.status(500).json({
                status: 'error',
                code:
                    'ADDRESS_UPDATE_FAILED',
                error:
                    err.message
            });

        } finally {
            client.release();
        }
    }
);


/*
 * ============================================================
 * ADMIN STALE ORDER CANCELLATION V1
 *
 * Narrow recovery action only.
 *
 * Policy ownership tetap berada di
 * AdminStaleOrderCancellationService:
 *
 * - role 4 only
 * - PENDING only
 * - DIRECT only
 * - stale >= 72 jam
 * - PAID blocked
 * - active UNPAID gateway blocked
 * - CONSUMED reservation blocked
 * - RESERVED released atomically
 * - FSM PENDING -> CANCELLED
 * - no payment mutation
 * - no physical inventory mutation
 * - no legacy tbl_orders mutation
 * ============================================================
 */
router.post(
    '/admin/operations/v1/orders/:orderId/cancel-stale',
    verifyToken,
    requireRole(4),
    async (req, res) => {
        const { orderId } =
            req.params;

        try {
            const result =
                await adminStaleOrderCancellationService
                    .cancel({
                        orderId,
                        adminUserId:
                            req.user.id,
                        minimumAgeHours:
                            72
                    });

            switch (result.status) {
            case 'success':
                return res.status(200).json({
                    status: 'success',
                    message:
                        'Pesanan stale berhasil dibatalkan',
                    cancellation:
                        result
                });

            case 'invalid_input':
                return res.status(400).json({
                    status: 'error',
                    code:
                        'STALE_CANCEL_INVALID_INPUT',
                    cancellation:
                        result
                });

            case 'minimum_age_invalid':
                return res.status(400).json({
                    status: 'error',
                    code:
                        'STALE_CANCEL_MINIMUM_AGE_INVALID',
                    cancellation:
                        result
                });

            case 'order_not_found':
                return res.status(404).json({
                    status: 'error',
                    code:
                        'STALE_CANCEL_ORDER_NOT_FOUND',
                    cancellation:
                        result
                });

            case 'order_not_pending':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'STALE_CANCEL_ORDER_NOT_PENDING',
                    cancellation:
                        result
                });

            case 'order_not_direct':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'STALE_CANCEL_ORDER_NOT_DIRECT',
                    cancellation:
                        result
                });

            case 'order_not_stale':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'STALE_CANCEL_ORDER_NOT_STALE',
                    cancellation:
                        result
                });

            case 'paid_payment_exists':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'STALE_CANCEL_PAID_PAYMENT_EXISTS',
                    cancellation:
                        result
                });

            case 'active_payment_exists':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'STALE_CANCEL_ACTIVE_PAYMENT_EXISTS',
                    cancellation:
                        result
                });

            case 'consumed_reservation_exists':
                return res.status(409).json({
                    status: 'error',
                    code:
                        'STALE_CANCEL_CONSUMED_RESERVATION_EXISTS',
                    cancellation:
                        result
                });

            default:
                return res.status(409).json({
                    status: 'error',
                    code:
                        'STALE_CANCEL_NOT_COMPLETED',
                    cancellation:
                        result
                });
            }

        } catch (err) {
            console.error(
                '[ADMIN STALE CANCELLATION V1]',
                err.message
            );

            return res.status(500).json({
                status: 'error',
                code:
                    'STALE_CANCEL_FAILED',
                error:
                    err.message
            });
        }
    }
);

module.exports = router;
