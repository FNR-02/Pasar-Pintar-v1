class MerchantEntitlementService {
    constructor(db) {
        this.db = db;
    }

    async recordFromOrderPaid(orderId) {
        if (!orderId) {
            throw new Error('order_id wajib');
        }

        const result = await this.db.query(
            `
            INSERT INTO tbl_merchant_entitlements (
                merchant_id,
                order_id,
                market_order_id,
                gross_amount,
                platform_commission,
                merchant_entitlement,
                status,
                source_event
            )
            SELECT
                o.merchant_id,
                o.id,
                o.market_order_id,
                o.total_amount,
                0,
                o.total_amount,
                'PENDING',
                'ORDER_PAID'
            FROM tbl_orders_v2 o
            WHERE o.id = $1
              AND o.market_order_id IS NOT NULL
              AND o.merchant_id IS NOT NULL
            ON CONFLICT (order_id)
            DO NOTHING
            RETURNING *
            `,
            [orderId]
        );

        if (result.rowCount === 1) {
            return {
                status: 'created',
                entitlement: result.rows[0]
            };
        }

        const existing = await this.db.query(
            `
            SELECT *
            FROM tbl_merchant_entitlements
            WHERE order_id = $1
            `,
            [orderId]
        );

        if (existing.rowCount === 1) {
            return {
                status: 'already_exists',
                entitlement: existing.rows[0]
            };
        }

        return {
            status: 'not_marketplace_order',
            entitlement: null
        };
    }
}

module.exports = MerchantEntitlementService;
