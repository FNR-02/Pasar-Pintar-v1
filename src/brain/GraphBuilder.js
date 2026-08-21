const CommerceKernel = require('../kernel/EventKernel');
const pool = require('../config/db');

CommerceKernel.on('ORDER_PAID', async (packet) => {
    const order = packet.payload || {};

    console.log(
        `[COMMERCE BRAIN] Order ${order.id}`
    );

    try {
        if (!order.id) throw new Error('Order ID tidak ditemukan');
        if (!order.customer_id) throw new Error('Customer ID tidak ditemukan');
        if (!order.merchant_id) throw new Error('Merchant ID tidak ditemukan');

        const items = await pool.query(
            `SELECT product_id, quantity
             FROM tbl_order_items
             WHERE order_id = $1`,
            [order.id]
        );
        await pool.query(
            `INSERT INTO tbl_knowledge_graph
             (source_type, source_id, relation, target_type, target_id, weight, metadata)
             VALUES ('CUSTOMER',$1,'BUYS_FROM','MERCHANT', $2, 1,
                     jsonb_build_object('last_order_id',$3::text))
             ON CONFLICT (source_type,source_id,relation,target_type,target_id)
             DO UPDATE SET
                 weight = tbl_knowledge_graph.weight + 1,
                 metadata = EXCLUDED.metadata,
                 updated_at = CURRENT_TIMESTAMP`,
            [order.customer_id, order.merchant_id, order.id]
        );

        console.log(
            `[COMMERCE BRAIN] CUSTOMER ${order.customer_id} -> BUYS_FROM -> MERCHANT ${order.merchant_id}`
        );

        for (const item of items.rows) {
            await pool.query(
                `INSERT INTO tbl_knowledge_graph
                 (source_type, source_id, relation, target_type, target_id, weight, metadata)
                 VALUES ('CUSTOMER',$1,'BUYS','PRODUCT',$2,$3,
                         jsonb_build_object('last_order_id',$4::text))
                 ON CONFLICT (source_type,source_id,relation,target_type,target_id)
                 DO UPDATE SET
                     weight = tbl_knowledge_graph.weight + EXCLUDED.weight,
                     metadata = EXCLUDED.metadata,
                     updated_at = CURRENT_TIMESTAMP`,
                [
                    order.customer_id,
                    item.product_id,
                    item.quantity,
                    order.id
                ]
            );

            console.log(
                `[COMMERCE BRAIN] CUSTOMER ${order.customer_id} -> BUYS -> PRODUCT ${item.product_id}`
            );
        }

        console.log(
            `[COMMERCE BRAIN] OK Order ${order.id}`
        );

    } catch (err) {
        console.error(
            `[BRAIN ERROR] ${err.message}`
        );
    }
});
