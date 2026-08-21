// src/kernel/inventorySubscribers.js
const CommerceKernel = require('./EventKernel');
const pool = require('../config/db');

CommerceKernel.on('PRODUCT_CREATED', async (packet) => {
    const product = packet.payload || {};

    console.log(
        `[INVENTORY ENGINE] Memvalidasi inventory produk ID: ${product.id}`
    );

    try {
        const result = await pool.query(
            `SELECT
                id,
                warehouse_id,
                product_id,
                quantity_on_hand,
                min_stock_level,
                max_stock_level
             FROM tbl_inventory
             WHERE product_id = $1`,
            [product.id]
        );

        if (result.rowCount === 0) {
            console.warn(
                `[INVENTORY ENGINE] Inventory belum ditemukan untuk produk ID: ${product.id}`
            );
            return;
        }

        console.log(
            `[INVENTORY ENGINE] Inventory tervalidasi untuk produk ID: ${product.id} ` +
            `(${result.rowCount} warehouse)`
        );
    } catch (err) {
        console.error(
            "[INVENTORY ERROR] Gagal memvalidasi inventory:",
            err.message
        );
    }
});
