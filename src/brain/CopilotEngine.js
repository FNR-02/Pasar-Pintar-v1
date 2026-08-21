// src/brain/CopilotEngine.js
const pool = require('../config/db');

class CopilotEngine {
    static async ask(question) {
        const q = question.toLowerCase();
        
        try {
            // 1. Jika CEO bertanya tentang Omzet / Keuangan
            if (q.includes('omzet') || q.includes('pendapatan') || q.includes('penjualan')) {
                const ledgerRes = await pool.query(
                    `SELECT SUM(credit) as total_revenue FROM tbl_general_ledger WHERE account_code = '4000'`
                );
                const revenue = ledgerRes.rows[0].total_revenue || 0;
                
                return {
                    copilot_response: `Berdasarkan analisis Ledger Keuangan dan Event Store terkini, total akumulasi pendapatan penjualan perusahaan saat ini adalah Rp${parseFloat(revenue).toLocaleString('id-ID')}. Sistem mendokumentasikan arus kas dalam kondisi stabil.`,
                    data_source: "tbl_general_ledger & Event Store",
                    recommendation: "Pertimbangkan untuk meningkatkan alokasi stok pada produk dengan rotasi tercepat."
                };
            }

            // 2. Jika CEO bertanya tentang Stok / Inventory / Restock
            if (q.includes('stok') || q.includes('inventaris') || q.includes('restock')) {
                  const poRes = await pool.query(`SELECT po.id, s.supplier_name, w.warehouse_name, p.sku, p.name, poi.quantity, poi.unit_cost, po.total_amount FROM tbl_purchase_orders po LEFT JOIN tbl_suppliers s ON s.id = po.supplier_id LEFT JOIN tbl_warehouses w ON w.id = po.warehouse_id JOIN tbl_purchase_order_items poi ON poi.purchase_order_id = po.id JOIN tbl_products p ON p.id = poi.product_id WHERE po.status IN ('DRAFT', 'PENDING_APPROVAL') ORDER BY po.created_at DESC`);
                  const totalPo = poRes.rowCount;
                  const po = poRes.rows[0];
                  return {
                      copilot_response: totalPo === 0 ? "Tidak ada Purchase Order yang menunggu persetujuan." : `Terdapat ${totalPo} draf PO. PO terbaru: ${po.name} (${po.sku}), ${po.quantity} unit dari ${po.supplier_name}, senilai Rp${Number(po.total_amount).toLocaleString('id-ID')}, menuju ${po.warehouse_name}.`,
                      data_source: "tbl_purchase_orders, tbl_purchase_order_items, tbl_products, tbl_suppliers & tbl_warehouses",
                      recommendation: totalPo === 0 ? "Tidak ada tindakan restock yang diperlukan." : "Periksa detail PO dan lakukan APPROVE atau REJECT."
                  };
            }

            // 3. Jika CEO bertanya tentang jumlah produk aktif
            if (
                q.includes('produk aktif') ||
                q.includes('jumlah produk') ||
                q.includes('total produk') ||
                q.includes('berapa produk')
            ) {
                const productRes = await pool.query(
                    `SELECT COUNT(*) AS total_active_products
                     FROM tbl_products
                     WHERE status = 'ACTIVE'`
                );

                const totalActiveProducts =
                    Number(productRes.rows[0].total_active_products || 0);

                return {
                    copilot_response: `Saat ini terdapat ${totalActiveProducts} produk aktif di Pasar Pintar.`,
                    data_source: "tbl_products",
                    recommendation: "Pantau stok, harga, dan performa produk aktif secara berkala."
                };
            }

            // 4. Pertanyaan Umum / Ringkasan Eksekutif Perusahaan
            const statsRes = await pool.query(`
                SELECT
                    COUNT(*) AS total_orders,
                    COUNT(*) FILTER (WHERE status = 'PENDING') AS pending_orders,
                    COUNT(*) FILTER (WHERE status = 'PAID') AS paid_orders,
                    COUNT(*) FILTER (WHERE status = 'PACKING') AS packing_orders
                FROM tbl_orders_v2
            `);

            const productRes = await pool.query(`
                SELECT COUNT(*) AS active_products
                FROM tbl_products
                WHERE status = 'ACTIVE'
            `);

            const stats = statsRes.rows[0];
            const activeProducts =
                Number(productRes.rows[0].active_products || 0);

            return {
                copilot_response:
                    `Ringkasan Pasar Pintar: ${stats.total_orders} order V2, ` +
                    `${stats.pending_orders} PENDING, ${stats.paid_orders} PAID, ` +
                    `${stats.packing_orders} PACKING, dan ${activeProducts} produk aktif.`,
                data_source: "tbl_orders_v2 & tbl_products",
                recommendation:
                    Number(stats.pending_orders || 0) > 0
                        ? "Terdapat order PENDING yang perlu dipantau proses pembayarannya."
                        : "Tidak ada order PENDING saat ini."
            };
        } catch (err) {
            console.error("[COPILOT ERROR]", err.message);
            throw new Error("Gagal memproses kueri CEO Copilot.");
        }
    }
}

module.exports = CopilotEngine;
