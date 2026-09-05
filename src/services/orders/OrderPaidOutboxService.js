const pool = require('../../config/db');

class OrderPaidOutboxService {
    constructor(db = pool) {
        this.db = db;
    }

    async verifyCompletion(orderId) {
        const result = await this.db.query(
            `
            WITH ctx AS (
                SELECT
                    o.id,
                    o.customer_id,
                    o.merchant_id,
                    o.market_order_id,
                    o.total_amount::numeric AS total_amount,
                    o.status AS order_status,
                    o.fulfillment_type,
                    p.payment_status,
                    p.provider,
                    p.payment_method,
                    c.user_id,
                    c.phone,
                    c.phone_verified_at,
                    m.phone AS merchant_phone,
                    m.status AS merchant_status
                FROM tbl_orders_v2 o
                JOIN tbl_payments p
                  ON p.order_id = o.id
                 AND p.payment_status = 'PAID'
                JOIN tbl_customers c
                  ON c.id = o.customer_id
                LEFT JOIN tbl_merchants m
                  ON m.id = o.merchant_id
                WHERE o.id = $1
                LIMIT 1
            )
            SELECT
                id AS order_id,

                order_status IN (
                    'PACKING',
                    'DISPATCHED',
                    'DELIVERED'
                ) AS canonical_order_ok,

                payment_status = 'PAID'
                    AS payment_ok,

                (
                    (
                        UPPER(
                            COALESCE(
                                ctx.fulfillment_type,
                                ''
                            )
                        ) = 'PICKUP'
                        AND UPPER(
                            COALESCE(
                                ctx.provider,
                                ''
                            )
                        ) = 'OUTLET'
                        AND UPPER(
                            COALESCE(
                                ctx.payment_method,
                                ''
                            )
                        ) = 'PAY_AT_OUTLET'
                    )
                    OR NOT EXISTS (
                        SELECT 1
                        FROM tbl_order_items oi
                        WHERE oi.order_id = ctx.id
                          AND COALESCE((
                              SELECT SUM(im.quantity)
                              FROM tbl_inventory_movements im
                              WHERE im.product_id = oi.product_id
                                AND im.movement_type = 'SALE'
                                AND im.reference_doc =
                                    'ORD-' || ctx.id::text
                          ), 0) < oi.quantity
                    )
                ) AS inventory_sale_ok,

                (
                    (
                        UPPER(
                            COALESCE(
                                ctx.fulfillment_type,
                                ''
                            )
                        ) = 'PICKUP'
                        AND UPPER(
                            COALESCE(
                                ctx.provider,
                                ''
                            )
                        ) = 'OUTLET'
                        AND UPPER(
                            COALESCE(
                                ctx.payment_method,
                                ''
                            )
                        ) = 'PAY_AT_OUTLET'
                    )
                    OR NOT EXISTS (
                        SELECT 1
                        FROM tbl_inventory_reservations r
                        WHERE r.order_id = ctx.id
                          AND r.status = 'RESERVED'
                    )
                ) AS reservation_ok,

                (
                    (
                        ctx.market_order_id IS NOT NULL
                        AND UPPER(
                            COALESCE(
                                ctx.provider,
                                ''
                            )
                        ) = 'OUTLET'
                        AND UPPER(
                            COALESCE(
                                ctx.payment_method,
                                ''
                            )
                        ) = 'PAY_AT_OUTLET'
                    )
                    OR
                    (
                        ctx.market_order_id IS NOT NULL
                        AND (
                            SELECT COUNT(*)
                            FROM tbl_general_ledger gl
                            WHERE gl.transaction_reference =
                                  'ORD-' || ctx.id::text
                              AND (
                                  (
                                      gl.account_code = '1400'
                                      AND gl.debit =
                                          ctx.total_amount
                                      AND gl.credit = 0
                                  )
                                  OR
                                  (
                                      gl.account_code = '2200'
                                      AND gl.credit =
                                          ctx.total_amount
                                      AND gl.debit = 0
                                  )
                              )
                        ) = 2
                    )
                    OR
                    (
                        ctx.market_order_id IS NULL
                        AND (
                            SELECT COUNT(*)
                            FROM tbl_general_ledger gl
                            WHERE gl.transaction_reference =
                                  'ORD-' || ctx.id::text
                              AND (
                                  (
                                      gl.account_code = '1100'
                                      AND gl.debit =
                                          ctx.total_amount
                                      AND gl.credit = 0
                                  )
                                  OR
                                  (
                                      gl.account_code = '4000'
                                      AND gl.credit =
                                          ctx.total_amount
                                      AND gl.debit = 0
                                  )
                              )
                        ) = 2
                    )
                ) AS finance_ok,

                EXISTS (
                    SELECT 1
                    FROM tbl_loyalty_points lp
                    WHERE lp.customer_id = ctx.customer_id
                      AND lp.transaction_type = 'ORDER_PAID'
                      AND lp.description =
                          'ORDER_PAID:' || ctx.id::text
                ) AS loyalty_ok,

                (
                    ctx.user_id IS NULL
                    OR EXISTS (
                        SELECT 1
                        FROM tbl_notifications n
                        WHERE n.event_key =
                              'ORDER_PAID:' || ctx.id::text
                    )
                ) AS crm_notification_ok,

                EXISTS (
                    SELECT 1
                    FROM tbl_knowledge_graph_order_applied kg
                    WHERE kg.order_id = ctx.id
                ) AS graph_ok,

                (
                    ctx.phone IS NULL
                    OR ctx.phone_verified_at IS NULL
                    OR EXISTS (
                        SELECT 1
                        FROM tbl_whatsapp_notification_deliveries wd
                        WHERE wd.event_key =
                              'WHATSAPP:ORDER_PAID:' || ctx.id::text
                          AND wd.status = 'SENT'
                    )
                ) AS whatsapp_owned_ok,
                (
                    ctx.merchant_id IS NULL
                    OR COALESCE(
                        ctx.merchant_status,
                        ''
                    ) <> 'ACTIVE'
                    OR NULLIF(
                        BTRIM(ctx.merchant_phone),
                        ''
                    ) IS NULL
                    OR EXISTS (
                        SELECT 1
                        FROM tbl_whatsapp_notification_deliveries wd
                        WHERE wd.event_key =
                              'WHATSAPP:MERCHANT:ORDER_ACTIONABLE:' ||
                              ctx.id::text
                          AND wd.status = 'SENT'
                    )
                ) AS merchant_whatsapp_ok

            FROM ctx
            `,
            [orderId]
        );

        if (!result.rowCount) {
            return {
                complete: false,
                found: false,
                orderId,
                checks: {}
            };
        }

        const checks = result.rows[0];

        const complete = [
            checks.canonical_order_ok,
            checks.payment_ok,
            checks.inventory_sale_ok,
            checks.reservation_ok,
            checks.finance_ok,
            checks.loyalty_ok,
            checks.crm_notification_ok,
            checks.graph_ok,
            checks.whatsapp_owned_ok,
            checks.merchant_whatsapp_ok
        ].every(Boolean);

        return {
            complete,
            found: true,
            orderId,
            checks
        };
    }

    async recoverStaleWhatsAppPending(orderId) {
        const result = await this.db.query(
            `
            UPDATE tbl_whatsapp_notification_deliveries
            SET
                status = 'FAILED',
                last_error =
                    'Recovered stale ORDER_PAID PENDING delivery',
                updated_at = CURRENT_TIMESTAMP
            WHERE (
                    (
                        event_key =
                            'WHATSAPP:ORDER_PAID:' ||
                            $1::text
                        AND notification_type =
                            'ORDER_PAID'
                    )
                    OR
                    (
                        event_key =
                            'WHATSAPP:MERCHANT:ORDER_ACTIONABLE:' ||
                            $1::text
                        AND notification_type =
                            'MERCHANT_ORDER_ACTIONABLE'
                    )
                  )
              AND status = 'PENDING'
              AND updated_at <=
                  CURRENT_TIMESTAMP -
                  INTERVAL '5 minutes'
            RETURNING
                id,
                event_key,
                status,
                attempts,
                updated_at
            `,
            [orderId]
        );

        return result.rows[0] || null;
    }

    async findDuePending(limit = 10) {
        const safeLimit = Math.max(
            1,
            Math.min(Number(limit) || 10, 100)
        );

        const result = await this.db.query(
            `
            SELECT
                id,
                order_id,
                payload,
                attempt_count,
                next_attempt_at,
                processed_at,
                last_error
            FROM tbl_order_paid_outbox
            WHERE processed_at IS NULL
              AND next_attempt_at <= CURRENT_TIMESTAMP
            ORDER BY next_attempt_at, created_at
            LIMIT $1
            `,
            [safeLimit]
        );

        return result.rows;
    }

    async scheduleReplay(orderId, reason = null) {
        const result = await this.db.query(
            `
            UPDATE tbl_order_paid_outbox
            SET attempt_count = attempt_count + 1,
                next_attempt_at =
                    CURRENT_TIMESTAMP + INTERVAL '30 seconds',
                last_error = $2,
                updated_at = CURRENT_TIMESTAMP
            WHERE order_id = $1
              AND processed_at IS NULL
              AND next_attempt_at <= CURRENT_TIMESTAMP
            RETURNING
                id,
                order_id,
                payload,
                attempt_count,
                next_attempt_at,
                processed_at,
                last_error
            `,
            [
                orderId,
                reason
                    ? String(reason).slice(0, 2000)
                    : null
            ]
        );

        return result.rows[0] || null;
    }

    async markProcessed(orderId) {
        const verification =
            await this.verifyCompletion(orderId);

        if (!verification.complete) {
            return {
                status: 'not_complete',
                verification
            };
        }

        const result = await this.db.query(
            `
            UPDATE tbl_order_paid_outbox
            SET processed_at = COALESCE(
                    processed_at,
                    CURRENT_TIMESTAMP
                ),
                last_error = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE order_id = $1
            RETURNING
                id,
                order_id,
                attempt_count,
                processed_at,
                last_error
            `,
            [orderId]
        );

        return {
            status:
                result.rowCount
                    ? 'processed'
                    : 'outbox_not_found',
            outbox:
                result.rows[0] || null,
            verification
        };
    }
}

module.exports = OrderPaidOutboxService;
