// src/brain/agents/InventoryAgent.js

const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'pasarpintar',
    password: 'pasarpintar',
    port: 5432,
});

const CommerceKernel = require('../../kernel/EventKernel');

class InventoryAgent {

    static async runAuditAndRestock() {

        console.log(
            '[INVENTORY AGENT] 🤖 Memindai inventaris Enterprise...'
        );

        try {

            /*
             * ============================================================
             * 1. BACA INVENTARIS
             * ============================================================
             *
             * PENTING:
             * tbl_products.id = UUID
             * tbl_inventory.product_id = UUID
             *
             * Jangan gunakan tbl_produk di agent ini.
             */

            const inventoryQuery = `
                SELECT
                    p.id AS product_id,
                    p.sku,
                    p.name,

                    i.id AS inventory_id,
                      i.warehouse_id,

                    COALESCE(i.quantity_on_hand, 0) AS quantity_on_hand,
                    COALESCE(i.min_stock_level, 5) AS min_stock_level,
                    COALESCE(i.max_stock_level, 100) AS max_stock_level

                FROM tbl_products p

                INNER JOIN tbl_inventory i
                    ON i.product_id = p.id

                ORDER BY p.name
            `;

            const inventoryResult =
                await pool.query(inventoryQuery);

            if (inventoryResult.rowCount === 0) {

                console.log(
                    '[INVENTORY AGENT] Tidak ada inventaris yang dapat diaudit.'
                );

                return;
            }

            /*
             * ============================================================
             * 2. ANALISIS SETIAP PRODUK
             * ============================================================
             */

            for (const item of inventoryResult.rows) {

                const currentStock =
                    Number(item.quantity_on_hand);

                const minStock =
                    Number(item.min_stock_level);

                const maxStock =
                    Number(item.max_stock_level);

                /*
                 * ========================================================
                 * STOK AMAN
                 * ========================================================
                 */

                if (currentStock > minStock) {

                    console.log(
                        `[INVENTORY AGENT] ✅ ${item.name} ` +
                        `(SKU: ${item.sku}) ` +
                        `stok aman: ${currentStock}`
                    );
await pool.query('UPDATE tbl_inventory_alert_states SET state = $1, last_stock = $2, updated_at = CURRENT_TIMESTAMP WHERE inventory_id = $3', ['NORMAL', currentStock, item.inventory_id]);
                    continue;
                }

                /*
                 * ========================================================
                 * STOK KRITIS
                 * ========================================================
                 */

                const restockQuantity =
                    Math.max(maxStock - currentStock, 0);

                console.log(
                    `[INVENTORY AGENT] 🚨 STOCK LOW: ${item.name} ` +
                    `(stok ${currentStock}, minimum ${minStock}, ` +
                    `target ${maxStock})`
                );

                /*
                 * ========================================================
                 * 3. CEK APAKAH SUDAH ADA DRAFT PO
                 * ========================================================
                 */
const alertStateResult = await pool.query('SELECT state, last_stock FROM tbl_inventory_alert_states WHERE inventory_id = $1', [item.inventory_id]);


if (alertStateResult.rowCount > 0 && alertStateResult.rows[0].state === 'LOW' && Number(alertStateResult.rows[0].last_stock) === currentStock) {
    continue;
}
                const existingPoQuery = `
                    SELECT
                        po.id,
                        po.status,
                        po.created_at

                    FROM tbl_purchase_orders po

                    INNER JOIN tbl_purchase_order_items poi
                        ON poi.purchase_order_id = po.id

                    WHERE poi.product_id = $1

                    AND po.status IN (
                        'DRAFT',
                        'PENDING_APPROVAL'
                    )

                    LIMIT 1
                `;

                const existingPo =
                    await pool.query(
                        existingPoQuery,
                        [item.product_id]
                    );

                if (existingPo.rowCount > 0) {

                    console.log(
                        `[INVENTORY AGENT] ⏸️ Draft PO sudah ada ` +
                        `untuk ${item.name}. Tidak membuat duplikat.`
                    );

                      await pool.query("INSERT INTO tbl_inventory_alert_states (inventory_id, alert_type, state, last_alert_at, last_stock) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4) ON CONFLICT (inventory_id) DO UPDATE SET alert_type = EXCLUDED.alert_type, state = EXCLUDED.state, last_alert_at = EXCLUDED.last_alert_at, last_stock = EXCLUDED.last_stock, updated_at = CURRENT_TIMESTAMP", [item.inventory_id, "STOCK_LOW_ALERT", "LOW", currentStock]);
                    continue;
                }

                /*
                 * ========================================================
                 * 4. CEK SUPPLIER
                 * ========================================================
                 *
                 * Saat ini tbl_suppliers masih kosong.
                 */

                const supplierQuery = `
                    SELECT
                        id,
                        supplier_name
                    FROM tbl_suppliers
                    ORDER BY created_at ASC
                    LIMIT 1
                `;

                const supplierResult =
                    await pool.query(supplierQuery);

                /*
                 * ========================================================
                 * 5. CEK COST
                 * ========================================================
                 *
                 * RETAIL BUKAN COGS.
                 *
                 * Untuk sementara kita hanya mencari price_type
                 * selain RETAIL.
                 */

                const costQuery = `
                    SELECT
                        amount,
                        price_type,
                        effective_date

                    FROM tbl_product_prices

                    WHERE product_id = $1

                    AND UPPER(price_type) <> 'RETAIL'

                    ORDER BY effective_date DESC

                    LIMIT 1
                `;

                const costResult =
                    await pool.query(
                        costQuery,
                        [item.product_id]
                    );

                /*
                 * ========================================================
                 * 6. BELUM ADA SUPPLIER / COST
                 * ========================================================
                 */

                if (
                    supplierResult.rowCount === 0 ||
                    costResult.rowCount === 0
                ) {

                    console.log(
                        `[INVENTORY AGENT] 💡 REKOMENDASI RESTOCK: ` +
                        `${item.name} → ${restockQuantity} unit`
                    );

                    console.log(
                        `[INVENTORY AGENT] ` +
                        `Supplier: ${
                            supplierResult.rowCount === 0
                                ? 'BELUM TERSEDIA'
                                : supplierResult.rows[0].supplier_name
                        }`
                    );

                    console.log(
                        `[INVENTORY AGENT] ` +
                        `COGS: ${
                            costResult.rowCount === 0
                                ? 'BELUM TERSEDIA'
                                : costResult.rows[0].amount
                        }`
                    );

                    /*
                     * Kirim event bahwa AI merekomendasikan restock,
                     * tetapi BELUM membuat PO.
                     */

                    CommerceKernel.emitEvent(
                        'STOCK_LOW_ALERT',
                        'INVENTORY',
                        item.product_id,
                        {
                            product_id: item.product_id,
                            sku: item.sku,
                            product_name: item.name,

                            current_stock: currentStock,
                            min_stock_level: minStock,
                            max_stock_level: maxStock,

                            recommended_restock_quantity:
                                restockQuantity,

                            decision: 'RECOMMEND_RESTOCK',

                            purchase_order_created: false,

                            reason:
                                supplierResult.rowCount === 0
                                    ? 'SUPPLIER_NOT_AVAILABLE'
                                    : 'COST_NOT_AVAILABLE'
                        }
                    );
await pool.query('INSERT INTO tbl_inventory_alert_states (inventory_id, alert_type, state, last_alert_at, last_stock) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4) ON CONFLICT (inventory_id) DO UPDATE SET alert_type = EXCLUDED.alert_type, state = EXCLUDED.state, last_alert_at = EXCLUDED.last_alert_at, last_stock = EXCLUDED.last_stock, updated_at = CURRENT_TIMESTAMP', [item.inventory_id, 'STOCK_LOW_ALERT', 'LOW', currentStock]);
                    continue;
                }

                /*
                 * ========================================================
                 * 7. SUPPLIER + COST TERSEDIA
                 * ========================================================
                 */

                const supplier =
                    supplierResult.rows[0];

                const cost =
                    Number(costResult.rows[0].amount);

                /*
                 * ========================================================
                 * 8. BUAT DRAFT PO
                 * ========================================================
                 */

                const client =
                    await pool.connect();

                try {

                    await client.query('BEGIN');

                    const poResult = await client.query(
                        `
                        INSERT INTO tbl_purchase_orders
                        (
                            supplier_id,
                              warehouse_id,
                            status,
                            total_amount,
                            created_at
                        )
                        VALUES
                        (
                            $1,
                              $2,
                            'DRAFT',
                            $3,
                            CURRENT_TIMESTAMP
                        )
                        RETURNING id
                        `,
                        [
                            supplier.id,
                              item.warehouse_id,
                            restockQuantity * cost
                        ]
                    );

                    const purchaseOrderId =
                        poResult.rows[0].id;

                    await client.query(
                        `
                        INSERT INTO tbl_purchase_order_items
                        (
                            purchase_order_id,
                            product_id,
                            quantity,
                            unit_cost
                        )
                        VALUES
                        (
                            $1,
                            $2,
                            $3,
                            $4
                        )
                        `,
                        [
                            purchaseOrderId,
                            item.product_id,
                            restockQuantity,
                            cost
                        ]
                    );

                    await client.query('COMMIT');

                    console.log(
                        `[INVENTORY AGENT] 📝 DRAFT PO dibuat ` +
                        `untuk ${item.name}: ${purchaseOrderId}`
                    );

                    CommerceKernel.emitEvent(
                        'PURCHASE_ORDER_DRAFT_CREATED',
                        'INVENTORY',
                        item.product_id,
                        {
                            purchase_order_id:
                                purchaseOrderId,

                            product_id:
                                item.product_id,

                            quantity:
                                restockQuantity,

                            unit_cost:
                                cost,

                            total_amount:
                                restockQuantity * cost,

                            supplier_id:
                                supplier.id
                        }
                    );

                } catch (poError) {

                    await client.query('ROLLBACK');

                    throw poError;

                } finally {

                    client.release();
                }
            }

        } catch (err) {

            console.error(
                '[AGENT ERROR] Gagal menjalankan Inventory Agent:',
                err.message
            );
        }
    }
}


/*
 * ============================================================
 * JANGAN menjalankan audit berkali-kali secara agresif.
 *
 * Audit pertama dilakukan saat server memuat module.
 * Kemudian setiap 5 menit.
 * ============================================================
 */

setTimeout(() => {

    InventoryAgent.runAuditAndRestock();

}, 3000);


setInterval(() => {

    InventoryAgent.runAuditAndRestock();

}, 300000);


module.exports = InventoryAgent;
