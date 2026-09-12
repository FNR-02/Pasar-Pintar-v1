const express = require('express');
const router = express.Router();
const B2BReceivingService = require('../services/b2b/B2BReceivingService');

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


/*
 * GET /api/merchant/b2b/orders
 *
 * Daftar PO B2B milik merchant yang sedang login.
 */
router.get(
    '/merchant/b2b/orders',
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

            const result =
                await pool.query(
                    `
                    SELECT
                        o.id,
                        o.status,
                        o.payment_mode,
                        o.total_amount,
                        o.notes,
                        o.created_at,
                        o.submitted_at,
                        o.approved_at,
                        o.received_at,
                        seller.store_name
                            AS seller_store_name,
                        sw.warehouse_name
                            AS source_warehouse_name,
                        dw.warehouse_name
                            AS destination_warehouse_name,
                        COUNT(oi.id)::integer
                            AS item_count
                    FROM tbl_b2b_orders o
                    JOIN tbl_merchants seller
                      ON seller.id =
                            o.seller_merchant_id
                    JOIN tbl_warehouses sw
                      ON sw.id =
                            o.source_warehouse_id
                    JOIN tbl_warehouses dw
                      ON dw.id =
                            o.destination_warehouse_id
                    LEFT JOIN tbl_b2b_order_items oi
                      ON oi.b2b_order_id = o.id
                    WHERE o.buyer_merchant_id = $1
                    GROUP BY
                        o.id,
                        seller.store_name,
                        sw.warehouse_name,
                        dw.warehouse_name
                    ORDER BY
                        o.created_at DESC
                    `,
                    [buyer.id]
                );

            return res.json({
                status:
                    'success',
                count:
                    result.rowCount,
                orders:
                    result.rows
            });
        } catch (err) {
            console.error(
                '[MERCHANT B2B ORDERS]',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Gagal memuat PO B2B'
                });
        }
    }
);

/*
 * POST /api/merchant/b2b/orders
 *
 * Membuat PO B2B DRAFT.
 *
 * Browser hanya boleh mengirim:
 * - destination_warehouse_id
 * - items [{ product_id, quantity }]
 * - notes
 *
 * Seller, buyer, source warehouse, harga,
 * satuan, stok dan total berasal dari backend.
 */
router.post(
    '/merchant/b2b/orders',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        let client;

        try {
            const destinationWarehouseId =
                String(
                    req.body
                        ?.destination_warehouse_id
                        || ''
                ).trim();

            const requestedItems =
                Array.isArray(req.body?.items)
                    ? req.body.items
                    : [];

            const notes =
                String(
                    req.body?.notes || ''
                )
                    .trim()
                    .slice(0, 1000);

            if (!destinationWarehouseId) {
                return res
                    .status(400)
                    .json({
                        error:
                            'Warehouse tujuan wajib dipilih'
                    });
            }

            if (
                requestedItems.length === 0
                || requestedItems.length > 100
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            'Item PO wajib diisi'
                    });
            }

            const normalizedItems = [];
            const seenProducts = new Set();

            for (const rawItem of requestedItems) {
                const productId =
                    String(
                        rawItem?.product_id
                        || ''
                    ).trim();

                const quantity =
                    Number(
                        rawItem?.quantity
                    );

                if (
                    !productId
                    || !Number.isInteger(quantity)
                    || quantity <= 0
                ) {
                    return res
                        .status(400)
                        .json({
                            error:
                                'Product ID dan quantity PO tidak valid'
                        });
                }

                if (seenProducts.has(productId)) {
                    return res
                        .status(400)
                        .json({
                            error:
                                'Produk yang sama tidak boleh dikirim dua kali'
                        });
                }

                seenProducts.add(productId);

                normalizedItems.push({
                    product_id:
                        productId,
                    quantity
                });
            }

            client =
                await pool.connect();

            await client.query('BEGIN');

            const buyerResult =
                await client.query(
                    `
                    SELECT
                        id,
                        store_name
                    FROM tbl_merchants
                    WHERE user_id = $1
                      AND status = 'ACTIVE'
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [req.user.id]
                );

            if (
                buyerResult.rowCount === 0
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(403)
                    .json({
                        error:
                            'Merchant pembeli aktif tidak ditemukan'
                    });
            }

            const buyer =
                buyerResult.rows[0];

            const sellerResult =
                await client.query(
                    `
                    SELECT
                        id,
                        store_name
                    FROM tbl_merchants
                    WHERE store_name = $1
                      AND status = 'ACTIVE'
                    ORDER BY created_at ASC
                    LIMIT 1
                    `,
                    [
                        B2B_SELLER_STORE_NAME
                    ]
                );

            if (
                sellerResult.rowCount === 0
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(503)
                    .json({
                        error:
                            'Merchant B2B Pasar Pintar belum tersedia'
                    });
            }

            const seller =
                sellerResult.rows[0];

            if (buyer.id === seller.id) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(403)
                    .json({
                        error:
                            'Merchant seller tidak dapat membeli dari dirinya sendiri'
                    });
            }

            const sourceWarehouseResult =
                await client.query(
                    `
                    SELECT
                        id,
                        warehouse_name
                    FROM tbl_warehouses
                    WHERE merchant_id = $1
                      AND warehouse_type =
                            'MERCHANT_STORE'
                    ORDER BY
                        created_at ASC,
                        warehouse_name ASC
                    LIMIT 1
                    `,
                    [seller.id]
                );

            if (
                sourceWarehouseResult.rowCount
                === 0
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(503)
                    .json({
                        error:
                            'Warehouse seller B2B belum tersedia'
                    });
            }

            const sourceWarehouse =
                sourceWarehouseResult.rows[0];

            const destinationResult =
                await client.query(
                    `
                    SELECT
                        id,
                        warehouse_name
                    FROM tbl_warehouses
                    WHERE id = $1
                      AND merchant_id = $2
                      AND warehouse_type =
                            'MERCHANT_STORE'
                    LIMIT 1
                    `,
                    [
                        destinationWarehouseId,
                        buyer.id
                    ]
                );

            if (
                destinationResult.rowCount
                === 0
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(400)
                    .json({
                        error:
                            'Warehouse tujuan merchant tidak valid'
                    });
            }

            const validatedItems = [];
            let totalAmount = 0;

            for (
                const requestedItem
                of normalizedItems
            ) {
                const productResult =
                    await client.query(
                        `
                        SELECT
                            p.id,
                            p.sku,
                            p.name,
                            p.selling_unit,
                            p.pack_size_value,
                            p.pack_size_unit,
                            wholesale.amount
                                AS unit_price,
                            COALESCE(
                                i.quantity_on_hand,
                                0
                            )::integer AS stock
                        FROM tbl_products p

                        JOIN LATERAL (
                            SELECT
                                pp.amount
                            FROM tbl_product_prices pp
                            WHERE pp.product_id =
                                    p.id
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

                        WHERE p.id = $1
                          AND p.merchant_id = $3
                          AND p.status = 'ACTIVE'
                        LIMIT 1
                        `,
                        [
                            requestedItem.product_id,
                            sourceWarehouse.id,
                            seller.id
                        ]
                    );

                if (
                    productResult.rowCount
                    === 0
                ) {
                    await client.query(
                        'ROLLBACK'
                    );

                    return res
                        .status(400)
                        .json({
                            error:
                                'Produk tidak tersedia di katalog B2B'
                        });
                }

                const product =
                    productResult.rows[0];

                if (
                    requestedItem.quantity
                    > product.stock
                ) {
                    await client.query(
                        'ROLLBACK'
                    );

                    return res
                        .status(409)
                        .json({
                            error:
                                `Stok ${product.name} tidak mencukupi`,
                            available_stock:
                                product.stock
                        });
                }

                const unitPrice =
                    Number(
                        product.unit_price
                    );

                const lineTotal =
                    unitPrice
                    * requestedItem.quantity;

                totalAmount += lineTotal;

                validatedItems.push({
                    ...product,
                    quantity:
                        requestedItem.quantity,
                    unit_price:
                        unitPrice,
                    line_total:
                        lineTotal
                });
            }

            const orderResult =
                await client.query(
                    `
                    INSERT INTO tbl_b2b_orders (
                        seller_merchant_id,
                        buyer_merchant_id,
                        source_warehouse_id,
                        destination_warehouse_id,
                        status,
                        payment_mode,
                        total_amount,
                        notes,
                        created_by
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        'DRAFT',
                        'CASH',
                        $5,
                        NULLIF($6, ''),
                        $7
                    )
                    RETURNING
                        id,
                        status,
                        payment_mode,
                        total_amount,
                        created_at
                    `,
                    [
                        seller.id,
                        buyer.id,
                        sourceWarehouse.id,
                        destinationWarehouseId,
                        totalAmount,
                        notes,
                        req.user.id
                    ]
                );

            const order =
                orderResult.rows[0];

            for (
                const item
                of validatedItems
            ) {
                await client.query(
                    `
                    INSERT INTO tbl_b2b_order_items (
                        b2b_order_id,
                        source_product_id,
                        quantity,
                        unit_price,
                        line_total,
                        selling_unit_snapshot,
                        pack_size_value_snapshot,
                        pack_size_unit_snapshot
                    )
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8
                    )
                    `,
                    [
                        order.id,
                        item.id,
                        item.quantity,
                        item.unit_price,
                        item.line_total,
                        item.selling_unit,
                        item.pack_size_value,
                        item.pack_size_unit
                    ]
                );
            }

            await client.query('COMMIT');

            return res
                .status(201)
                .json({
                    status:
                        'success',
                    message:
                        'Draft PO B2B berhasil dibuat',
                    order: {
                        ...order,
                        buyer_store_name:
                            buyer.store_name,
                        seller_store_name:
                            seller.store_name,
                        source_warehouse_name:
                            sourceWarehouse
                                .warehouse_name,
                        destination_warehouse_name:
                            destinationResult
                                .rows[0]
                                .warehouse_name,
                        item_count:
                            validatedItems.length,
                        items:
                            validatedItems.map(
                                item => ({
                                    product_id:
                                        item.id,
                                    sku:
                                        item.sku,
                                    name:
                                        item.name,
                                    quantity:
                                        item.quantity,
                                    unit_price:
                                        item.unit_price,
                                    line_total:
                                        item.line_total,
                                    selling_unit:
                                        item.selling_unit
                                })
                            )
                    }
                });
        } catch (err) {
            if (client) {
                try {
                    await client.query(
                        'ROLLBACK'
                    );
                } catch (_) {}
            }

            console.error(
                '[MERCHANT B2B CREATE ORDER]',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Gagal membuat PO B2B'
                });
        } finally {
            if (client) {
                client.release();
            }
        }
    }
);


/*
 * POST /api/merchant/b2b/orders/:id/submit
 *
 * Merchant pembeli mengirim DRAFT menjadi SUBMITTED.
 *
 * Saat submit:
 * - ownership diperiksa dari user login
 * - seller/product divalidasi ulang
 * - WHOLESALE price dibaca ulang dari backend
 * - stok source warehouse diperiksa ulang
 * - total PO dihitung ulang
 *
 * Belum ada pengurangan/reservasi stok.
 */
router.post(
    '/merchant/b2b/orders/:id/submit',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        let client;

        try {
            const orderId =
                String(
                    req.params.id || ''
                ).trim();

            if (!orderId) {
                return res
                    .status(400)
                    .json({
                        error:
                            'ID PO B2B tidak valid'
                    });
            }

            client =
                await pool.connect();

            await client.query('BEGIN');

            const buyerResult =
                await client.query(
                    `
                    SELECT
                        id,
                        store_name
                    FROM tbl_merchants
                    WHERE user_id = $1
                      AND status = 'ACTIVE'
                    LIMIT 1
                    `,
                    [req.user.id]
                );

            if (
                buyerResult.rowCount === 0
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(403)
                    .json({
                        error:
                            'Merchant pembeli aktif tidak ditemukan'
                    });
            }

            const buyer =
                buyerResult.rows[0];

            const orderResult =
                await client.query(
                    `
                    SELECT
                        id,
                        seller_merchant_id,
                        buyer_merchant_id,
                        source_warehouse_id,
                        destination_warehouse_id,
                        status,
                        payment_mode,
                        total_amount
                    FROM tbl_b2b_orders
                    WHERE id = $1
                      AND buyer_merchant_id = $2
                    FOR UPDATE
                    `,
                    [
                        orderId,
                        buyer.id
                    ]
                );

            if (
                orderResult.rowCount === 0
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(404)
                    .json({
                        error:
                            'PO B2B tidak ditemukan'
                    });
            }

            const order =
                orderResult.rows[0];

            /*
             * Retry aman jika tombol submit
             * terkirim dua kali.
             */
            if (
                order.status ===
                'SUBMITTED'
            ) {
                await client.query(
                    'COMMIT'
                );

                return res.json({
                    status:
                        'success',
                    message:
                        'PO B2B sudah disubmit',
                    order: {
                        id:
                            order.id,
                        status:
                            order.status,
                        payment_mode:
                            order.payment_mode,
                        total_amount:
                            order.total_amount
                    }
                });
            }

            if (
                order.status !== 'DRAFT'
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(409)
                    .json({
                        error:
                            `PO dengan status ${order.status} tidak dapat disubmit`
                    });
            }

            if (
                order.payment_mode !==
                'CASH'
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(409)
                    .json({
                        error:
                            'B2B V1 hanya mendukung CASH'
                    });
            }

            const itemsResult =
                await client.query(
                    `
                    SELECT
                        id,
                        source_product_id,
                        quantity
                    FROM tbl_b2b_order_items
                    WHERE b2b_order_id = $1
                    ORDER BY created_at ASC
                    `,
                    [order.id]
                );

            if (
                itemsResult.rowCount === 0
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(409)
                    .json({
                        error:
                            'PO B2B tidak memiliki item'
                    });
            }

            let totalAmount = 0;

            const submittedItems = [];

            for (
                const item
                of itemsResult.rows
            ) {
                const productResult =
                    await client.query(
                        `
                        SELECT
                            id,
                            sku,
                            name,
                            selling_unit,
                            pack_size_value,
                            pack_size_unit
                        FROM tbl_products
                        WHERE id = $1
                          AND merchant_id = $2
                          AND status = 'ACTIVE'
                        LIMIT 1
                        `,
                        [
                            item.source_product_id,
                            order.seller_merchant_id
                        ]
                    );

                if (
                    productResult.rowCount
                    === 0
                ) {
                    await client.query(
                        'ROLLBACK'
                    );

                    return res
                        .status(409)
                        .json({
                            error:
                                'Salah satu produk PO sudah tidak aktif'
                        });
                }

                const product =
                    productResult.rows[0];

                const priceResult =
                    await client.query(
                        `
                        SELECT
                            amount
                        FROM tbl_product_prices
                        WHERE product_id = $1
                          AND price_type =
                                'WHOLESALE'
                          AND (
                                effective_date
                                    IS NULL
                                OR
                                effective_date
                                    <= CURRENT_DATE
                              )
                        ORDER BY
                            effective_date
                                DESC NULLS LAST,
                            id DESC
                        LIMIT 1
                        `,
                        [product.id]
                    );

                if (
                    priceResult.rowCount
                    === 0
                ) {
                    await client.query(
                        'ROLLBACK'
                    );

                    return res
                        .status(409)
                        .json({
                            error:
                                `Harga grosir ${product.name} tidak tersedia`
                        });
                }

                const inventoryResult =
                    await client.query(
                        `
                        SELECT
                            quantity_on_hand
                        FROM tbl_inventory
                        WHERE product_id = $1
                          AND warehouse_id = $2
                        FOR UPDATE
                        `,
                        [
                            product.id,
                            order.source_warehouse_id
                        ]
                    );

                const availableStock =
                    inventoryResult.rowCount
                        ? Number(
                            inventoryResult
                                .rows[0]
                                .quantity_on_hand
                        )
                        : 0;

                if (
                    Number(item.quantity)
                    > availableStock
                ) {
                    await client.query(
                        'ROLLBACK'
                    );

                    return res
                        .status(409)
                        .json({
                            error:
                                `Stok ${product.name} tidak mencukupi`,
                            available_stock:
                                availableStock
                        });
                }

                const unitPrice =
                    Number(
                        priceResult
                            .rows[0]
                            .amount
                    );

                const lineTotal =
                    unitPrice
                    * Number(
                        item.quantity
                    );

                totalAmount += lineTotal;

                await client.query(
                    `
                    UPDATE tbl_b2b_order_items
                    SET
                        unit_price = $2,
                        line_total = $3,
                        selling_unit_snapshot = $4,
                        pack_size_value_snapshot = $5,
                        pack_size_unit_snapshot = $6
                    WHERE id = $1
                    `,
                    [
                        item.id,
                        unitPrice,
                        lineTotal,
                        product.selling_unit,
                        product.pack_size_value,
                        product.pack_size_unit
                    ]
                );

                submittedItems.push({
                    product_id:
                        product.id,
                    sku:
                        product.sku,
                    name:
                        product.name,
                    quantity:
                        Number(
                            item.quantity
                        ),
                    unit_price:
                        unitPrice,
                    line_total:
                        lineTotal
                });
            }

            const updateResult =
                await client.query(
                    `
                    UPDATE tbl_b2b_orders
                    SET
                        status = 'SUBMITTED',
                        total_amount = $2,
                        submitted_at =
                            CURRENT_TIMESTAMP,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status = 'DRAFT'
                    RETURNING
                        id,
                        status,
                        payment_mode,
                        total_amount,
                        submitted_at
                    `,
                    [
                        order.id,
                        totalAmount
                    ]
                );

            if (
                updateResult.rowCount !== 1
            ) {
                throw new Error(
                    'B2B submit state transition gagal'
                );
            }

            await client.query('COMMIT');

            return res.json({
                status:
                    'success',
                message:
                    'PO B2B berhasil disubmit',
                order: {
                    ...updateResult.rows[0],
                    buyer_store_name:
                        buyer.store_name,
                    item_count:
                        submittedItems.length,
                    items:
                        submittedItems
                }
            });
        } catch (err) {
            if (client) {
                try {
                    await client.query(
                        'ROLLBACK'
                    );
                } catch (_) {}
            }

            console.error(
                '[MERCHANT B2B SUBMIT]',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Gagal submit PO B2B'
                });
        } finally {
            if (client) {
                client.release();
            }
        }
    }
);



/*
 * GET /api/admin/b2b/orders
 *
 * Daftar PO B2B untuk operasional admin.
 */
router.get(
    '/admin/b2b/orders',
    verifyToken,
    requireRole(4),
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT
                        o.id,
                        o.status,
                        o.payment_mode,
                        o.total_amount,
                        o.notes,
                        o.created_at,
                        o.submitted_at,
                        o.approved_at,
                        o.received_at,
                        seller.store_name
                            AS seller_store_name,
                        buyer.store_name
                            AS buyer_store_name,
                        sw.warehouse_name
                            AS source_warehouse_name,
                        dw.warehouse_name
                            AS destination_warehouse_name,
                        COUNT(oi.id)::integer
                            AS item_count,
                        COALESCE(
                            SUM(oi.quantity),
                            0
                        )::integer
                            AS total_quantity
                    FROM tbl_b2b_orders o
                    JOIN tbl_merchants seller
                      ON seller.id =
                            o.seller_merchant_id
                    JOIN tbl_merchants buyer
                      ON buyer.id =
                            o.buyer_merchant_id
                    JOIN tbl_warehouses sw
                      ON sw.id =
                            o.source_warehouse_id
                    JOIN tbl_warehouses dw
                      ON dw.id =
                            o.destination_warehouse_id
                    LEFT JOIN tbl_b2b_order_items oi
                      ON oi.b2b_order_id = o.id
                    GROUP BY
                        o.id,
                        seller.store_name,
                        buyer.store_name,
                        sw.warehouse_name,
                        dw.warehouse_name
                    ORDER BY
                        CASE o.status
                            WHEN 'SUBMITTED' THEN 1
                            WHEN 'APPROVED' THEN 2
                            WHEN 'DRAFT' THEN 3
                            WHEN 'RECEIVED' THEN 4
                            ELSE 5
                        END,
                        o.created_at DESC
                    LIMIT 200
                    `
                );

            return res.json({
                status: 'success',
                count: result.rowCount,
                orders: result.rows
            });
        } catch (err) {
            console.error(
                '[ADMIN B2B ORDERS]',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Gagal memuat PO B2B admin'
                });
        }
    }
);

/*
 * POST /api/admin/b2b/orders/:id/approve
 *
 * Admin menyetujui PO B2B:
 * SUBMITTED -> APPROVED
 *
 * Tidak memotong stok.
 * Tidak mengubah snapshot harga PO.
 */
router.post(
    '/admin/b2b/orders/:id/approve',
    verifyToken,
    requireRole(4),
    async (req, res) => {
        let client;

        try {
            const orderId =
                String(
                    req.params.id || ''
                ).trim();

            if (!orderId) {
                return res
                    .status(400)
                    .json({
                        error:
                            'ID PO B2B tidak valid'
                    });
            }

            client =
                await pool.connect();

            await client.query('BEGIN');

            const orderResult =
                await client.query(
                    `
                    SELECT
                        o.id,
                        o.seller_merchant_id,
                        o.buyer_merchant_id,
                        o.source_warehouse_id,
                        o.destination_warehouse_id,
                        o.status,
                        o.payment_mode,
                        o.total_amount,
                        seller.store_name
                            AS seller_store_name,
                        buyer.store_name
                            AS buyer_store_name
                    FROM tbl_b2b_orders o
                    JOIN tbl_merchants seller
                      ON seller.id =
                            o.seller_merchant_id
                    JOIN tbl_merchants buyer
                      ON buyer.id =
                            o.buyer_merchant_id
                    WHERE o.id = $1
                    FOR UPDATE OF o
                    `,
                    [orderId]
                );

            if (
                orderResult.rowCount === 0
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(404)
                    .json({
                        error:
                            'PO B2B tidak ditemukan'
                    });
            }

            const order =
                orderResult.rows[0];

            if (
                order.status ===
                'APPROVED'
            ) {
                await client.query(
                    'COMMIT'
                );

                return res.json({
                    status:
                        'success',
                    message:
                        'PO B2B sudah disetujui',
                    order
                });
            }

            if (
                order.status !==
                'SUBMITTED'
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(409)
                    .json({
                        error:
                            `PO dengan status ${order.status} tidak dapat disetujui`
                    });
            }

            if (
                order.payment_mode !==
                'CASH'
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(409)
                    .json({
                        error:
                            'B2B V1 hanya mendukung CASH'
                    });
            }

            const sourceWarehouseResult =
                await client.query(
                    `
                    SELECT id
                    FROM tbl_warehouses
                    WHERE id = $1
                      AND merchant_id = $2
                      AND warehouse_type =
                            'MERCHANT_STORE'
                    LIMIT 1
                    `,
                    [
                        order.source_warehouse_id,
                        order.seller_merchant_id
                    ]
                );

            if (
                sourceWarehouseResult.rowCount
                === 0
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(409)
                    .json({
                        error:
                            'Warehouse sumber PO B2B tidak valid'
                    });
            }

            const destinationWarehouseResult =
                await client.query(
                    `
                    SELECT id
                    FROM tbl_warehouses
                    WHERE id = $1
                      AND merchant_id = $2
                      AND warehouse_type =
                            'MERCHANT_STORE'
                    LIMIT 1
                    `,
                    [
                        order.destination_warehouse_id,
                        order.buyer_merchant_id
                    ]
                );

            if (
                destinationWarehouseResult.rowCount
                === 0
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(409)
                    .json({
                        error:
                            'Warehouse tujuan PO B2B tidak valid'
                    });
            }

            const itemsResult =
                await client.query(
                    `
                    SELECT
                        oi.id,
                        oi.source_product_id,
                        oi.quantity,
                        oi.unit_price,
                        oi.line_total,
                        p.name
                    FROM tbl_b2b_order_items oi
                    JOIN tbl_products p
                      ON p.id =
                            oi.source_product_id
                    WHERE oi.b2b_order_id = $1
                      AND p.merchant_id = $2
                      AND p.status = 'ACTIVE'
                    ORDER BY oi.created_at ASC
                    `,
                    [
                        order.id,
                        order.seller_merchant_id
                    ]
                );

            const itemCountResult =
                await client.query(
                    `
                    SELECT
                        COUNT(*)::integer
                            AS item_count
                    FROM tbl_b2b_order_items
                    WHERE b2b_order_id = $1
                    `,
                    [order.id]
                );

            const expectedItemCount =
                Number(
                    itemCountResult
                        .rows[0]
                        .item_count
                );

            if (
                expectedItemCount === 0
                || itemsResult.rowCount
                    !== expectedItemCount
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(409)
                    .json({
                        error:
                            'Semua item PO B2B harus tetap aktif dan valid sebelum approval'
                    });
            }

            let calculatedTotal = 0;

            for (
                const item
                of itemsResult.rows
            ) {
                const inventoryResult =
                    await client.query(
                        `
                        SELECT
                            quantity_on_hand
                        FROM tbl_inventory
                        WHERE product_id = $1
                          AND warehouse_id = $2
                        FOR UPDATE
                        `,
                        [
                            item.source_product_id,
                            order.source_warehouse_id
                        ]
                    );

                const availableStock =
                    inventoryResult.rowCount
                        ? Number(
                            inventoryResult
                                .rows[0]
                                .quantity_on_hand
                        )
                        : 0;

                if (
                    Number(item.quantity)
                    > availableStock
                ) {
                    await client.query(
                        'ROLLBACK'
                    );

                    return res
                        .status(409)
                        .json({
                            error:
                                `Stok ${item.name} tidak mencukupi untuk approval`,
                            available_stock:
                                availableStock
                        });
                }

                calculatedTotal +=
                    Number(item.line_total);
            }

            if (
                Number(order.total_amount)
                !== calculatedTotal
            ) {
                await client.query(
                    'ROLLBACK'
                );

                return res
                    .status(409)
                    .json({
                        error:
                            'Total PO B2B tidak konsisten'
                    });
            }

            const updateResult =
                await client.query(
                    `
                    UPDATE tbl_b2b_orders
                    SET
                        status = 'APPROVED',
                        approved_at =
                            CURRENT_TIMESTAMP,
                        approved_by = $2,
                        updated_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status = 'SUBMITTED'
                    RETURNING
                        id,
                        status,
                        payment_mode,
                        total_amount,
                        approved_at,
                        approved_by
                    `,
                    [
                        order.id,
                        req.user.id
                    ]
                );

            if (
                updateResult.rowCount !== 1
            ) {
                throw new Error(
                    'B2B approval state transition gagal'
                );
            }

            await client.query('COMMIT');

            return res.json({
                status:
                    'success',
                message:
                    'PO B2B berhasil disetujui',
                order: {
                    ...updateResult.rows[0],
                    buyer_store_name:
                        order.buyer_store_name,
                    seller_store_name:
                        order.seller_store_name,
                    item_count:
                        itemsResult.rowCount
                }
            });
        } catch (err) {
            if (client) {
                try {
                    await client.query(
                        'ROLLBACK'
                    );
                } catch (_) {}
            }

            console.error(
                '[ADMIN B2B APPROVE]',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Gagal menyetujui PO B2B'
                });
        } finally {
            if (client) {
                client.release();
            }
        }
    }
);


/*
 * POST /api/merchant/b2b/orders/:id/receive
 *
 * Buyer merchant menerima PO yang sudah APPROVED.
 * Proses stok dilakukan atomik oleh B2BReceivingService.
 */
router.post(
    '/merchant/b2b/orders/:id/receive',
    verifyToken,
    requireRole(2),
    async (req, res) => {
        try {
            const orderId =
                String(
                    req.params.id || ''
                ).trim();

            if (!orderId) {
                return res
                    .status(400)
                    .json({
                        error:
                            'ID PO B2B tidak valid'
                    });
            }

            const service =
                new B2BReceivingService(
                    pool
                );

            const result =
                await service.receive({
                    orderId,
                    userId:
                        req.user.id
                });

            return res.json({
                status:
                    'success',
                message:
                    result.already_received
                        ? 'PO B2B sudah diterima'
                        : 'PO B2B berhasil diterima',
                order:
                    result.order
            });
        } catch (err) {
            const httpStatus =
                Number(
                    err.httpStatus
                ) || 500;

            if (httpStatus >= 500) {
                console.error(
                    '[MERCHANT B2B RECEIVE]',
                    err
                );
            }

            const payload = {
                error:
                    httpStatus >= 500
                        ? 'Gagal menerima PO B2B'
                        : err.message
            };

            if (
                err.available_stock
                !== undefined
            ) {
                payload.available_stock =
                    err.available_stock;
            }

            return res
                .status(httpStatus)
                .json(payload);
        }
    }
);

module.exports = router;
