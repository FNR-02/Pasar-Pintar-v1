const CommerceKernel = require('./EventKernel');
const pool = require('../config/db');

CommerceKernel.on('ORDER_PAID', async (packet) => {
    const order = packet.payload || {};
    const orderId = order.orderId || order.id;

    console.log(
        `[WAREHOUSE V2] Memproses Order: ${orderId}`
    );

    if (!orderId) {
        console.error('[WAREHOUSE V2] Order ID tidak ditemukan');
        return;
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const itemsResult = await client.query(
            `SELECT id, product_id, quantity, unit_price
             FROM tbl_order_items
             WHERE order_id = $1
             ORDER BY id`,
            [orderId]
        );

        if (!itemsResult.rowCount) {
            throw new Error(
                `Order ${orderId} tidak memiliki item`
            );
        }

        for (const item of itemsResult.rows) {
            const qty = Number(item.quantity);

            if (!Number.isInteger(qty) || qty <= 0) {
                throw new Error(
                    `Quantity tidak valid: ${item.quantity}`
                );
            }

            const referenceDoc = `ORD-${orderId}`;

            const existing = await client.query(
                `SELECT COALESCE(SUM(quantity), 0) AS moved
                 FROM tbl_inventory_movements
                 WHERE product_id = $1
                   AND movement_type = 'SALE'
                   AND reference_doc = $2`,
                [item.product_id, referenceDoc]
            );

            const moved = Number(existing.rows[0].moved || 0);

            if (moved >= qty) {
                console.log(
                    `[WAREHOUSE V2] SKIP ${item.product_id}: ` +
                    `sudah diproses`
                );
                continue;
            }

            const remaining = qty - moved;

            const inventory = await client.query(
                `SELECT id, warehouse_id, product_id,
                        quantity_on_hand
                 FROM tbl_inventory
                 WHERE product_id = $1
                   AND COALESCE(quantity_on_hand, 0) >= $2
                 ORDER BY quantity_on_hand DESC
                 FOR UPDATE
                 LIMIT 1`,
                [item.product_id, remaining]
            );

            if (!inventory.rowCount) {
                throw new Error(
                    `Stok tidak mencukupi untuk ${item.product_id}`
                );
            }

            const inv = inventory.rows[0];

            const updated = await client.query(
                `UPDATE tbl_inventory
                 SET quantity_on_hand = quantity_on_hand - $1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2
                   AND quantity_on_hand >= $1
                 RETURNING id, warehouse_id,
                           product_id, quantity_on_hand`,
                [remaining, inv.id]
            );

            if (!updated.rowCount) {
                throw new Error(
                    `Gagal mengurangi stok ${item.product_id}`
                );
            }

            const result = updated.rows[0];

            await client.query(
                `INSERT INTO tbl_inventory_movements
                 (product_id, warehouse_id, movement_type,
                  quantity, reference_doc, created_by)
                 VALUES ($1, $2, 'SALE', $3, $4, NULL)`,
                [
                    item.product_id,
                    result.warehouse_id,
                    remaining,
                    referenceDoc
                ]
            );

            console.log(
                `[WAREHOUSE V2] ${item.product_id}: ` +
                `-${remaining}, stok=${result.quantity_on_hand}`
            );
        }

        await client.query('COMMIT');

        console.log(
            `[WAREHOUSE V2] Sukses Order ${orderId}`
        );

    } catch (err) {
        await client.query('ROLLBACK');

        console.error(
            `[WAREHOUSE V2 ERROR] ${err.message}`
        );

    } finally {
        client.release();
    }
});
