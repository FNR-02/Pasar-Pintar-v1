const pool = require('../config/db');

const GraphQuery = {
    async getCustomerInsights(customerId) {

        const summaryResult = await pool.query(`
            SELECT
                customer_id,
                COUNT(*)::int AS total_orders,
                COALESCE(SUM(total_amount),0)::numeric AS total_spent,
                COALESCE(AVG(total_amount),0)::numeric AS average_order_value,
                MIN(created_at) AS first_order,
                MAX(created_at) AS last_order
            FROM tbl_orders_v2
            WHERE customer_id = $1
              AND status IN ('PAID','PACKING')
            GROUP BY customer_id
        `, [customerId]);

        const summary = summaryResult.rows[0] || {
            customer_id: customerId,
            total_orders: 0,
            total_spent: 0,
            average_order_value: 0,
            first_order: null,
            last_order: null
        };

        const productsResult = await pool.query(`
            SELECT
                oi.product_id,
                COUNT(*)::int AS purchase_count,
                SUM(oi.quantity)::int AS total_quantity,
                COALESCE(
                    SUM(oi.quantity * oi.unit_price),0
                )::numeric AS total_value
            FROM tbl_order_items oi
            JOIN tbl_orders_v2 o ON o.id = oi.order_id
            WHERE o.customer_id = $1
              AND o.status IN ('PAID','PACKING')
            GROUP BY oi.product_id
            ORDER BY total_quantity DESC, total_value DESC
            LIMIT 10
        `, [customerId]);

        const merchantsResult = await pool.query(`
            SELECT
                merchant_id,
                COUNT(*)::int AS order_count,
                COALESCE(SUM(total_amount),0)::numeric AS total_value
            FROM tbl_orders_v2
            WHERE customer_id = $1
              AND status IN ('PAID','PACKING')
            GROUP BY merchant_id
            ORDER BY order_count DESC, total_value DESC
            LIMIT 10
        `, [customerId]);

        const graphResult = await pool.query(`
            SELECT
                relation,
                target_type,
                target_id,
                weight,
                metadata,
                updated_at
            FROM tbl_knowledge_graph
            WHERE source_type = 'CUSTOMER'
              AND source_id = $1
            ORDER BY weight DESC, updated_at DESC
            LIMIT 50
        `, [customerId]);

        const totalOrders = Number(summary.total_orders || 0);
        const totalSpent = Number(summary.total_spent || 0);

        return {
            customer_id: customerId,
            summary: {
                total_orders: totalOrders,
                total_spent: totalSpent,
                average_order_value: Number(
                    (totalOrders ? totalSpent / totalOrders : 0)
                    .toFixed(2)
                ),
                first_order: summary.first_order,
                last_order: summary.last_order
            },
            favorite_products: productsResult.rows,
            favorite_merchants: merchantsResult.rows,
            knowledge_graph: graphResult.rows
        };
    }
};

module.exports = GraphQuery;

