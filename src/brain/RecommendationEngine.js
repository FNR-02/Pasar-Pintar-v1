const pool = require('../config/db');

function calculateRecommendationScore({ categoryMatch, merchantMatch, popularity, stock }) {
    let score = 0;

    if (categoryMatch) score += 50;
    score += Math.min(Number(popularity || 0) * 5, 30);
    if (merchantMatch) score += 20;
    if (Number(stock || 0) > 0) score += 20;

    return score;
}

const RecommendationEngine = {

    async getRecommendations(customerId) {

        // 1. Cari produk yang paling sering dibeli customer
        const favoriteResult = await pool.query(`
            SELECT
                oi.product_id,
                COUNT(*)::int AS purchase_count,
                SUM(oi.quantity)::int AS total_quantity
            FROM tbl_order_items oi
            JOIN tbl_orders_v2 o
                ON o.id = oi.order_id
            WHERE o.customer_id = $1
              AND o.status IN ('PAID','PACKING')
            GROUP BY oi.product_id
            ORDER BY purchase_count DESC, total_quantity DESC
            LIMIT 5
        `, [customerId]);

          const purchasedProductIds = favoriteResult.rows.map(row => row.product_id);


          // 2. Cold Start Discovery
          if (!favoriteResult.rows.length) {
              const discoveryResult = await pool.query(`
                    SELECT
                        p.id AS product_id,
                        p.name,
                        p.sku,
                        p.merchant_id,
                        COALESCE(sales.global_quantity, 0)::int AS global_quantity,
                          COALESCE(sales.purchase_count, 0)::int AS purchase_count,
                          COALESCE(price.amount, 0)::numeric AS retail_price,
                          stock.total_stock AS stock
                    FROM tbl_products p
                    LEFT JOIN LATERAL (
                        SELECT COALESCE(SUM(quantity_on_hand), 0)::int AS total_stock
                        FROM tbl_inventory
                        WHERE product_id = p.id
                    ) stock ON true
                      LEFT JOIN LATERAL (
                          SELECT
                              COALESCE(SUM(oi.quantity), 0)::int AS global_quantity,
                              COUNT(*)::int AS purchase_count
                          FROM tbl_order_items oi
                          JOIN tbl_orders_v2 o ON o.id = oi.order_id
                          WHERE oi.product_id = p.id
                            AND o.status IN ('PAID','PACKING')
                      ) sales ON true
                      LEFT JOIN LATERAL (
                          SELECT amount
                          FROM tbl_product_prices
                          WHERE product_id = p.id
                            AND price_type = 'RETAIL'
                          ORDER BY effective_date DESC NULLS LAST
                          LIMIT 1
                      ) price ON true
                    WHERE COALESCE(stock.total_stock, 0) > 0
                      ORDER BY sales.global_quantity DESC,
                               sales.purchase_count DESC,
                               stock.total_stock DESC
                    LIMIT 10
              `);

              const recommendations = discoveryResult.rows.map(row => ({
                  product_id: row.product_id,
                  name: row.name,
                  sku: row.sku,
                    global_quantity: Number(row.global_quantity || 0),
                    purchase_count: Number(row.purchase_count || 0),
                    stock: Number(row.stock || 0),
                      retail_price: Number(row.retail_price || 0),
                    recommendation_score: Math.min(Number(row.global_quantity || 0) * 5, 50) + Math.min(Number(row.purchase_count || 0) * 2, 20) + (Number(row.stock || 0) > 0 ? 20 : 0) + 10,
                    reason: [
                        Number(row.global_quantity || 0) > 0 ? "Produk populer di Pasar Pintar" : "Produk discovery untuk customer baru",
                        Number(row.stock || 0) > 0 ? "Stok tersedia" : "Stok terbatas"
                    ]
              }));

              return {
                  customer_id: customerId,
                  status: "DISCOVERY_RECOMMENDATIONS_AVAILABLE",
                  based_on: {
                      type: "GLOBAL_DISCOVERY"
                  },
                  recommendations
              };
          }


        // 3. Ambil kategori dari produk favorit
        const categoryResult = await pool.query(`
            SELECT DISTINCT p.category_id
            FROM tbl_products p
            WHERE p.id = ANY($1::uuid[])
              AND p.category_id IS NOT NULL
        `, [
            favoriteResult.rows.map(row => row.product_id)
        ]);


        // 4. Jika produk favorit belum memiliki kategori
        if (!categoryResult.rows.length) {
            return {
                customer_id: customerId,
                status: 'NO_PRODUCT_CATEGORY',
                recommendations: []
            };
        }

        const categoryIds = categoryResult.rows
            .map(row => row.category_id);

        // 4B. Ambil merchant favorit customer
        const merchantResult = await pool.query(`
            SELECT merchant_id, COUNT(*)::int AS order_count
            FROM tbl_orders_v2
            WHERE customer_id = $1
              AND status IN ('PAID','PACKING')
              AND merchant_id IS NOT NULL
            GROUP BY merchant_id
            ORDER BY order_count DESC
            LIMIT 5
        `, [customerId]);

        const favoriteMerchantIds = merchantResult.rows
            .map(row => row.merchant_id);


        // 5. Cari produk lain dalam kategori yang sama
        const result = await pool.query(`
            SELECT
                p.id AS product_id,
                p.name,
                p.sku,
                p.merchant_id,
                (SELECT COUNT(*)::int
                 FROM tbl_order_items oi2
                 JOIN tbl_orders_v2 o2 ON o2.id = oi2.order_id
                 WHERE oi2.product_id = p.id
                   AND o2.status IN ('PAID','PACKING')) AS purchase_count,
                  (SELECT COALESCE(SUM(oi2.quantity), 0)::int
                   FROM tbl_order_items oi2
                   JOIN tbl_orders_v2 o2 ON o2.id = oi2.order_id
                   WHERE oi2.product_id = p.id
                     AND o2.status IN ('PAID','PACKING')) AS global_quantity,
                c.name AS category,
                COALESCE(price.amount, 0)::numeric AS retail_price,
                COALESCE(stock.total_stock, 0)::int AS stock
            FROM tbl_products p
            LEFT JOIN tbl_product_categories c
                ON c.id = p.category_id
            LEFT JOIN LATERAL (
                SELECT pp.amount
                FROM tbl_product_prices pp
                WHERE pp.product_id = p.id
                  AND pp.price_type = 'RETAIL'
                ORDER BY pp.effective_date DESC
                LIMIT 1
            ) price ON TRUE
            LEFT JOIN LATERAL (
                SELECT
                    COALESCE(SUM(i.quantity_on_hand), 0)::int
                    AS total_stock
                FROM tbl_inventory i
                WHERE i.product_id = p.id
            ) stock ON TRUE


            WHERE p.category_id = ANY($1::int[])

              AND p.id NOT IN (
                  SELECT oi.product_id
                  FROM tbl_order_items oi
                  JOIN tbl_orders_v2 o
                      ON o.id = oi.order_id
                  WHERE o.customer_id = $2
                    AND o.status IN ('PAID','PACKING')
              )

              AND COALESCE(stock.total_stock, 0) > 0

            ORDER BY
                stock.total_stock DESC,
                p.name ASC

            LIMIT 10
        `, [categoryIds, customerId]);


        // 6. Format hasil rekomendasi
        const recommendations = result.rows.map(row => {
            const score = calculateRecommendationScore({
                  merchantMatch: favoriteMerchantIds.includes(row.merchant_id),
                categoryMatch: true,
                popularity: Number(row.purchase_count || 0) + Number(row.global_quantity || 0) / 10,
                stock: row.stock
            });
              const merchantMatch = favoriteMerchantIds.includes(row.merchant_id);
              const reasons = [];

              if (true) reasons.push("Kategori yang sering dibeli");
              if (merchantMatch) reasons.push("Merchant yang sering digunakan");
              if (Number(row.purchase_count || 0) > 0 || Number(row.global_quantity || 0) > 0) reasons.push("Produk populer");
              if (Number(row.stock || 0) > 0) reasons.push("Stok tersedia");

            return {
            product_id: row.product_id,
            name: row.name,
            sku: row.sku,
            merchant_id: row.merchant_id,
            category: row.category,
            retail_price: Number(row.retail_price || 0),
                stock: Number(row.stock || 0),
                purchase_count: Number(row.purchase_count || 0),
                global_quantity: Number(row.global_quantity || 0),
                  recommendation_score: score,
                  reason: reasons
            };
        });


        recommendations.sort((a, b) => {
            if (b.recommendation_score !== a.recommendation_score) {
                return b.recommendation_score - a.recommendation_score;
            }
            if (b.global_quantity !== a.global_quantity) {
                return b.global_quantity - a.global_quantity;
            }
            if (b.purchase_count !== a.purchase_count) {
                return b.purchase_count - a.purchase_count;
            }
            return b.stock - a.stock;
        });

          // 6B. Diversifikasi rekomendasi berdasarkan merchant
          const merchantCounts = {};
          const diversifiedRecommendations = [];

          for (const recommendation of recommendations) {
              const merchantId = recommendation.merchant_id || "UNKNOWN";
              merchantCounts[merchantId] = merchantCounts[merchantId] || 0;

              if (merchantCounts[merchantId] >= 2) continue;

              diversifiedRecommendations.push(recommendation);
              merchantCounts[merchantId]++;

              if (diversifiedRecommendations.length >= 10) break;
          }

          recommendations.length = 0;
          recommendations.push(...diversifiedRecommendations);

        // 7. Kembalikan hasil recommendation
        return {
            customer_id: customerId,
            status: recommendations.length
                ? 'RECOMMENDATIONS_AVAILABLE'
                : 'NO_ALTERNATIVE_PRODUCTS',
            based_on: {
                favorite_products: favoriteResult.rows
            },
            recommendations
        };
    }
};

module.exports = RecommendationEngine;
