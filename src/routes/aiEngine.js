const express = require('express');
const { verifyToken, requireRole } = require('../middleware/auth');

module.exports = function(pool, CommerceKernel) {
    const router = express.Router();

    // 1. Analisis Prediksi Stok & Rekomendasi AI
    router.get('/analytics/recommendations', verifyToken, requireRole(4), async (req, res) => {
        try {
            // Contoh analisis sederhana berbasis data produk yang mendekati min_stock
            const simulateLow = req.query.simulate === 'low';
            const days = Math.min(
                Math.max(parseInt(req.query.days || '7', 10), 1),
                30
            );

            const lowStockItems = await pool.query(`
                SELECT
                    p.id,
                    p.name,
                    i.quantity_on_hand AS stock,
                    i.min_stock_level AS min_stock,
                    i.max_stock_level AS max_stock,
                    COALESCE(SUM(m.quantity), 0)::int AS units_sold
                FROM tbl_products p
                JOIN tbl_inventory i ON i.product_id = p.id
                LEFT JOIN tbl_inventory_movements m
                    ON m.product_id = p.id
                    AND m.movement_type = 'SALE'
                    AND m.created_at >= CURRENT_TIMESTAMP
                        - ($2 * INTERVAL '1 day')
                WHERE $1
                   OR i.quantity_on_hand <= i.min_stock_level + 3
                   OR m.product_id IS NOT NULL
                GROUP BY
                    p.id,
                    p.name,
                    i.quantity_on_hand,
                    i.min_stock_level,
                    i.max_stock_level
            `, [simulateLow, days]);

            const recommendations = lowStockItems.rows.map(item => {
                const currentStock = simulateLow
                    ? item.min_stock - 1
                    : item.stock;

                const avgDailySales = Number((item.units_sold / days).toFixed(2));
                const daysOfStock = avgDailySales > 0
                    ? Number((currentStock / avgDailySales).toFixed(2))
                    : null;
                const recommendedRestock = Math.max(
                    item.max_stock - currentStock,
                    0
                );

                const stockStatus =
                    currentStock <= 0
                        ? 'OUT_OF_STOCK'
                        : currentStock > item.max_stock
                            ? 'OVERSTOCK'
                            : daysOfStock === null
                                ? 'NO_SALES_DATA'
                                : daysOfStock <= 3
                                    ? 'CRITICAL'
                                    : daysOfStock <= 7
                                        ? 'WATCH'
                                        : 'SAFE';

                return {
                    productId: item.id,
                    productName: item.name,
                    currentStock,
                    minimumStock: item.min_stock,
                    maximumStock: item.max_stock,
                    unitsSold: Number(item.units_sold),
                    avgDailySales: Number((item.units_sold / days).toFixed(2)),
                    daysOfStock,
                    recommendedRestock,
                    stockStatus,
                    aiSuggestion:
                        stockStatus === 'OUT_OF_STOCK'
                            ? 'Stok habis. Segera lakukan restock.'
                            : stockStatus === 'CRITICAL'
                                ? `Segera lakukan restock ${recommendedRestock} unit.`
                                : stockStatus === 'WATCH'
                                    ? `Stok diperkirakan cukup ${daysOfStock} hari. Pertimbangkan restock.`
                                    : stockStatus === 'OVERSTOCK'
                                        ? `Stok berlebih ${currentStock - item.max_stock} unit. Jangan lakukan restock.`
                                        : stockStatus === 'NO_SALES_DATA'
                                            ? 'Belum ada data penjualan yang cukup untuk prediksi.'
                                            : 'Stok aman. Belum perlu restock.'
                };
            });

            CommerceKernel.emitEvent(
    'AI_ANALYSIS_EXECUTED',
    'AI_ANALYSIS',
    'AI_ANALYTICS',
    {
        totalAnalyzed: lowStockItems.rows.length,
        actor: req.user.username,
        ip: req.ip
    }
);

            res.json({
                status: "success",
                engine: "PasarPintar-AI-Core-v2",
                recommendations
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 2. Ringkasan AI Inventory untuk Dashboard
    router.get('/analytics/inventory-summary', verifyToken, requireRole(4), async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    COUNT(*)::int AS total_products,
                    COUNT(*) FILTER (
                        WHERE quantity_on_hand <= 0
                    )::int AS out_of_stock,
                    COUNT(*) FILTER (
                        WHERE quantity_on_hand > 0
                        AND quantity_on_hand <= min_stock_level
                    )::int AS critical,
                    COUNT(*) FILTER (
                        WHERE quantity_on_hand > min_stock_level
                        AND quantity_on_hand <= min_stock_level + 3
                    )::int AS low,
                    COUNT(*) FILTER (
                        WHERE quantity_on_hand > min_stock_level + 3
                    )::int AS normal
                FROM tbl_inventory
            `);

            const summary = result.rows[0];

            CommerceKernel.emitEvent(
                'AI_INVENTORY_SUMMARY_EXECUTED',
                'AI_ANALYSIS',
                'AI_ANALYTICS',
                {
                    totalProducts: summary.total_products,
                    actor: req.user.username,
                    ip: req.ip
                }
            );

            res.json({
                status: 'success',
                engine: 'PasarPintar-AI-Core-v2',
                summary: {
                    totalProducts: summary.total_products,
                    outOfStock: summary.out_of_stock,
                    critical: summary.critical,
                    low: summary.low,
                    normal: summary.normal
                }
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // 3. Analisis kecepatan penjualan AI
    router.get('/analytics/sales-velocity', verifyToken, requireRole(4), async (req, res) => {
        try {
            const days = Math.min(
                Math.max(parseInt(req.query.days || '7', 10), 1),
                30
            );

            const result = await pool.query(`
                SELECT
                    p.id AS product_id,
                    p.name AS product_name,
                    COALESCE(SUM(m.quantity), 0)::int AS units_sold,
                    ROUND(
                        (COALESCE(SUM(m.quantity), 0)::numeric / $1::numeric),
                        2
                    ) AS avg_daily_sales
                FROM tbl_products p
                LEFT JOIN tbl_inventory_movements m
                    ON m.product_id = p.id
                    AND m.movement_type = 'SALE'
                    AND m.created_at >= CURRENT_TIMESTAMP - ($1 * INTERVAL '1 day')
                GROUP BY p.id, p.name
                ORDER BY units_sold DESC, p.name
            `, [days]);

            CommerceKernel.emitEvent(
                'AI_SALES_VELOCITY_EXECUTED',
                'AI_ANALYSIS',
                'AI_ANALYTICS',
                {
                    days,
                    totalProducts: result.rows.length,
                    actor: req.user.username,
                    ip: req.ip
                }
            );

            res.json({
                status: 'success',
                engine: 'PasarPintar-AI-Core-v2',
                periodDays: days,
                products: result.rows
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/analytics/stock-forecast', verifyToken, requireRole(4), async (req, res) => {
        try {
            const days = Math.min(
                Math.max(parseInt(req.query.days || '7', 10), 1),
                30
            );

            const result = await pool.query(`
                SELECT
                    p.id AS product_id,
                    p.name AS product_name,
                    i.quantity_on_hand AS current_stock,
                    i.min_stock_level AS minimum_stock,
                    i.max_stock_level AS maximum_stock,
                    COALESCE(SUM(m.quantity), 0)::int AS units_sold,
                    ROUND(
                        COALESCE(SUM(m.quantity), 0)::numeric
                        / $1::numeric,
                        2
                    ) AS avg_daily_sales
                FROM tbl_products p
                JOIN tbl_inventory i
                    ON i.product_id = p.id
                LEFT JOIN tbl_inventory_movements m
                    ON m.product_id = p.id
                    AND m.movement_type = 'SALE'
                    AND m.created_at >= CURRENT_TIMESTAMP
                        - ($1 * INTERVAL '1 day')
                GROUP BY
                    p.id,
                    p.name,
                    i.quantity_on_hand,
                    i.min_stock_level,
                    i.max_stock_level
                ORDER BY p.name
            `, [days]);
            const forecast = result.rows.map(item => {
                const dailySales = Number(item.avg_daily_sales);
                const currentStock = Number(item.current_stock);

                const daysOfStock = dailySales > 0
                    ? Number((currentStock / dailySales).toFixed(2))
                    : null;

                let forecastStatus = 'NO_SALES_DATA';

                if (dailySales > 0) {
                    forecastStatus = daysOfStock <= 3
                        ? 'URGENT'
                        : daysOfStock <= 7
                            ? 'WATCH'
                            : 'SAFE';
                }
                return {
                    productId: item.product_id,
                    productName: item.product_name,
                    currentStock,
                    minimumStock: Number(item.minimum_stock),
                    maximumStock: Number(item.maximum_stock),
                    unitsSold: Number(item.units_sold),
                    avgDailySales: dailySales,
                    daysOfStock,
                    forecastStatus
                };
            });
            res.json({
                status: 'success',
                engine: 'PasarPintar-AI-Core-v2',
                periodDays: days,
                forecast
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });


    return router;
};
