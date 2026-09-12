const express = require('express');
const router = express.Router();

const pool = require('../config/db');
const {
    verifyToken,
    requireRole
} = require('../middleware/auth');

const B2B_SELLER_STORE_NAME =
    'Pasar Pintar Merchant';

/*
 * Resolve merchant aktif milik user login.
 */
async function resolveBuyerMerchant(userId) {
    const result =
        await pool.query(
            `
            SELECT
                id,
                store_name,
                status
            FROM tbl_merchants
            WHERE user_id = $1
              AND status = 'ACTIVE'
            LIMIT 1
            `,
            [userId]
        );

    return result.rows[0] || null;
}

/*
 * Seller B2B V1 adalah merchant internal
 * "Pasar Pintar Merchant".
 *
 * ID tidak diterima dari browser.
 */
async function resolveB2BSeller() {
    const result =
        await pool.query(
            `
            SELECT
                id,
                store_name,
                status
            FROM tbl_merchants
            WHERE store_name = $1
              AND status = 'ACTIVE'
            ORDER BY created_at ASC
            LIMIT 1
            `,
            [B2B_SELLER_STORE_NAME]
        );

    return result.rows[0] || null;
}

/*
 * Source warehouse seller.
 *
 * V1 menggunakan MERCHANT_STORE milik seller.
 * Warehouse tidak diterima dari browser.
 */
async function resolveSellerWarehouse(
    sellerMerchantId
) {
    const result =
        await pool.query(
            `
            SELECT
                id,
                warehouse_name,
                location,
                warehouse_type
            FROM tbl_warehouses
            WHERE merchant_id = $1
              AND warehouse_type =
                    'MERCHANT_STORE'
            ORDER BY
                created_at ASC,
                warehouse_name ASC
            LIMIT 1
            `,
            [sellerMerchantId]
        );

    return result.rows[0] || null;
}

/*
 * GET /api/merchant/b2b/catalog
 *
 * Merchant pembeli hanya dapat melihat:
 * - seller canonical Pasar Pintar Merchant
 * - produk ACTIVE
 * - harga WHOLESALE terbaru
 * - stok di source warehouse seller
 *
 * RETAIL / PURCHASE tidak dipakai sebagai
 * fallback agar harga B2B selalu eksplisit.
 */
router.get(
    '/merchant/b2b/catalog',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        try {
            const buyer =
                await resolveBuyerMerchant(
                    req.user.id
                );

            if (!buyer) {
                return res
                    .status(403)
                    .json({
                        error:
                            'Merchant pembeli aktif tidak ditemukan'
                    });
            }

            const seller =
                await resolveB2BSeller();

            if (!seller) {
                return res
                    .status(503)
                    .json({
                        error:
                            'Merchant B2B Pasar Pintar belum tersedia'
                    });
            }

            if (buyer.id === seller.id) {
                return res
                    .status(403)
                    .json({
                        error:
                            'Merchant seller B2B tidak dapat membeli dari dirinya sendiri'
                    });
            }

            const sourceWarehouse =
                await resolveSellerWarehouse(
                    seller.id
                );

            if (!sourceWarehouse) {
                return res
                    .status(503)
                    .json({
                        error:
                            'Warehouse B2B Pasar Pintar belum tersedia'
                    });
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        p.id,
                        p.sku,
                        p.name,
                        p.description,
                        p.category_id,
                        p.image_url,
                        p.selling_unit,
                        p.pack_size_value,
                        p.pack_size_unit,

                        wholesale.amount
                            AS wholesale_price,

                        COALESCE(
                            i.quantity_on_hand,
                            0
                        )::integer
                            AS stock,

                        i.min_stock_level,

                        $2::uuid
                            AS source_warehouse_id

                    FROM tbl_products p

                    JOIN LATERAL (
                        SELECT
                            pp.amount
                        FROM tbl_product_prices pp
                        WHERE pp.product_id = p.id
                          AND pp.price_type =
                                'WHOLESALE'
                          AND (
                                pp.effective_date
                                    IS NULL
                                OR
                                pp.effective_date
                                    <= CURRENT_DATE
                              )
                        ORDER BY
                            pp.effective_date
                                DESC NULLS LAST,
                            pp.id DESC
                        LIMIT 1
                    ) wholesale
                        ON TRUE

                    LEFT JOIN tbl_inventory i
                        ON i.product_id = p.id
                       AND i.warehouse_id = $2

                    WHERE p.merchant_id = $1
                      AND p.status = 'ACTIVE'

                    ORDER BY
                        p.name ASC,
                        p.sku ASC
                    `,
                    [
                        seller.id,
                        sourceWarehouse.id
                    ]
                );

            return res.json({
                status:
                    'success',

                buyer: {
                    merchant_id:
                        buyer.id,
                    store_name:
                        buyer.store_name
                },

                seller: {
                    merchant_id:
                        seller.id,
                    store_name:
                        seller.store_name
                },

                source_warehouse:
                    sourceWarehouse,

                currency:
                    'IDR',

                price_type:
                    'WHOLESALE',

                count:
                    result.rowCount,

                products:
                    result.rows
            });
        } catch (err) {
            console.error(
                '[MERCHANT B2B CATALOG]',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Gagal memuat katalog B2B'
                });
        }
    }
);

module.exports = router;
