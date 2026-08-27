const express = require('express');

const pool = require('../config/db');
const {
    verifyToken,
    requireRole
} = require('../middleware/auth');

const router = express.Router();

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

                    cr.full_name AS courier_name,
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

                LEFT JOIN tbl_couriers cr
                    ON cr.id = s.courier_id

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

            return res.json({
                status: 'success',

                generated_at:
                    new Date().toISOString(),

                summary:
                    summaryResult.rows[0],

                orders:
                    ordersResult.rows,

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

module.exports = router;
