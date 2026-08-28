const CommerceKernel = require('../kernel/EventKernel');
const pool = require('../config/db');

CommerceKernel.on('ORDER_PAID', async (packet) => {
    const eventOrder = packet.payload || {};
    let client;

    console.log(`[COMMERCE BRAIN] Order ${eventOrder.id}`);

    try {
        if (!eventOrder.id) {
            throw new Error('Order ID tidak ditemukan');
        }

        client = await pool.connect();
        await client.query('BEGIN');

        const claim = await client.query(
            `INSERT INTO tbl_knowledge_graph_order_applied (order_id)
             VALUES ($1)
             ON CONFLICT (order_id) DO NOTHING
             RETURNING order_id`,
            [eventOrder.id]
        );

        if (claim.rowCount === 0) {
            await client.query('ROLLBACK');
            console.log(
                `[COMMERCE BRAIN] SKIP Order ${eventOrder.id} sudah diproses`
            );
            return;
        }

        const orderResult = await client.query(
            `SELECT id, customer_id, merchant_id
             FROM tbl_orders_v2
             WHERE id = $1`,
            [eventOrder.id]
        );

        if (orderResult.rowCount !== 1) {
            throw new Error('Order tidak ditemukan');
        }

        const order = orderResult.rows[0];

        if (!order.customer_id) {
            throw new Error('Customer ID tidak ditemukan');
        }

        if (!order.merchant_id) {
            throw new Error('Merchant ID tidak ditemukan');
        }

        const items = await client.query(
            `SELECT product_id, quantity
             FROM tbl_order_items
             WHERE order_id = $1`,
            [order.id]
        );

        await client.query(
            `INSERT INTO tbl_knowledge_graph
             (source_type, source_id, relation, target_type, target_id, weight, metadata)
             VALUES ('CUSTOMER',$1,'BUYS_FROM','MERCHANT',$2,1,
                     jsonb_build_object('last_order_id',$3::text))
             ON CONFLICT (source_type,source_id,relation,target_type,target_id)
             DO UPDATE SET
                 weight = tbl_knowledge_graph.weight + 1,
                 metadata = EXCLUDED.metadata,
                 updated_at = CURRENT_TIMESTAMP`,
            [order.customer_id, order.merchant_id, order.id]
        );

        for (const item of items.rows) {
            await client.query(
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
        }

        await client.query('COMMIT');

        console.log(`[COMMERCE BRAIN] OK Order ${order.id}`);
    } catch (err) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackErr) {
                console.error(
                    `[BRAIN ROLLBACK ERROR] ${rollbackErr.message}`
                );
            }
        }

        console.error(`[BRAIN ERROR] ${err.message}`);
    } finally {
        if (client) {
            client.release();
        }
    }
});
