const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const CommerceKernel = require('../kernel/EventKernel');
const { verifyToken, requireRole } = require('../middleware/auth');

const CustomerReceivableService =
    require(
        '../services/credit/CustomerReceivableService'
    );

const OrderInventoryFulfillmentService =
    require(
        '../services/orders/OrderInventoryFulfillmentService'
    );

const OrderInventoryReservationService =
    require(
        '../services/orders/OrderInventoryReservationService'
    );

const MarketCheckoutService =
    require('../services/marketplace/MarketCheckoutService');

const MarketPaymentService =
    require('../services/marketplace/MarketPaymentService');


// ============================================================
// PASAR PINTAR MARKETPLACE CATALOG V1
// Satu source-of-truth untuk katalog publik dan customer login.
// ============================================================
async function catalogProductsHandler(req, res) {
    try {
        const result = await pool.query(`
            SELECT
                p.id,
                p.merchant_id,
                p.sku,
                p.name,
                p.description,
                p.image_url,
                p.category_id,
                category.name AS category_name,
                parent_category.name AS parent_category_name,
                p.selling_unit,
                p.pack_size_value,
                p.pack_size_unit,
                p.parent_product_id,
                p.variant_label,
                parent.name AS parent_product_name,
                parent.sku AS parent_product_sku,
                parent.image_url AS parent_product_image_url,
                m.store_name,
                m.address AS merchant_address,
                mk.id AS market_id,
                mk.name AS market_name,
                mk.code AS market_code,
                mm.stall_name,
                mm.stall_number,
                COALESCE(price.amount, 0) AS price,
                COALESCE(inv.stock, 0) AS stock
            FROM tbl_products p

            LEFT JOIN tbl_products parent
                ON parent.id = p.parent_product_id
               AND parent.merchant_id = p.merchant_id

            INNER JOIN tbl_merchants m
                ON m.id = p.merchant_id
               AND m.status = 'ACTIVE'

            INNER JOIN tbl_market_merchants mm
                ON mm.merchant_id = m.id
               AND mm.status = 'ACTIVE'

            INNER JOIN tbl_markets mk
                ON mk.id = mm.market_id
               AND mk.status = 'ACTIVE'
               AND mk.code = 'PASAR-SEDERHANA'

            LEFT JOIN tbl_product_categories category
                ON category.id = p.category_id

            LEFT JOIN tbl_product_categories parent_category
                ON parent_category.id = category.parent_id

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
                    SUM(i.quantity_on_hand)::int AS stock
                FROM tbl_inventory i
                WHERE i.product_id = p.id
            ) inv ON TRUE

            WHERE p.status = 'ACTIVE'
              AND p.customer_visible = TRUE

            ORDER BY p.created_at DESC
        `);

        return res.json({
            status: 'success',
            count: result.rowCount,
            data: result.rows
        });

    } catch (err) {
        console.error(
            '[MARKETPLACE CATALOG ERROR]',
            err.message
        );

        return res.status(500).json({
            error: 'Gagal memuat katalog'
        });
    }
}

// Marketplace publik.
// Tidak memerlukan token.
// Hanya menampilkan produk ACTIVE + customer_visible
// dari merchant ACTIVE.
router.get(
    '/public/catalog/products',
    catalogProductsHandler
);

// Katalog untuk customer yang sudah login.
// Tetap mempertahankan proteksi lama.
router.get(
    '/catalog/products',
    verifyToken,
    requireRole(1, 4),
    catalogProductsHandler
);

router.post('/orders/checkout-v2', verifyToken, requireRole(1, 4), async (req, res) => {
    const {
        customer_id,
        items,
        shipping_address,
        fulfillment_type = 'DELIVERY',
        payment_mode = 'DIRECT',
        credit_account_id = null,
        pickup_payment = null
    } = req.body;

    const paymentMode =
        String(payment_mode || 'DIRECT')
            .trim()
            .toUpperCase();

    if (!['DIRECT', 'TEMPO'].includes(paymentMode)) {
        return res.status(400).json({
            error:
                'payment_mode harus DIRECT atau TEMPO'
        });
    }

    if (
        paymentMode === 'TEMPO' &&
        Number(req.user.role_id) !== 1
    ) {
        return res.status(403).json({
            error:
                'TEMPO hanya tersedia untuk Customer'
        });
    }

    if (
        paymentMode === 'TEMPO' &&
        !credit_account_id
    ) {
        return res.status(400).json({
            error:
                'credit_account_id wajib untuk TEMPO'
        });
    }

    const pickupPayment =
        pickup_payment === null ||
        pickup_payment === undefined ||
        String(pickup_payment).trim() === ''
            ? null
            : String(pickup_payment)
                .trim()
                .toUpperCase();

    if (
        pickupPayment !== null &&
        !['ONLINE', 'OUTLET'].includes(pickupPayment)
    ) {
        return res.status(400).json({
            error:
                'pickup_payment harus ONLINE atau OUTLET'
        });
    }

    const fulfillmentType =
        String(fulfillment_type || 'DELIVERY')
            .trim()
            .toUpperCase();

    if (!['DELIVERY', 'PICKUP'].includes(fulfillmentType)) {
        return res.status(400).json({
            error: 'fulfillment_type harus DELIVERY atau PICKUP'
        });
    }

    if (
        fulfillmentType === 'DELIVERY' &&
        !String(shipping_address || '').trim()
    ) {
        return res.status(400).json({
            error: 'Alamat pengiriman wajib diisi untuk DELIVERY'
        });
    }

    if (
        pickupPayment !== null &&
        fulfillmentType !== 'PICKUP'
    ) {
        return res.status(400).json({
            error:
                'pickup_payment hanya tersedia untuk PICKUP'
        });
    }

    if (
        pickupPayment === 'OUTLET' &&
        paymentMode !== 'DIRECT'
    ) {
        return res.status(409).json({
            error:
                'Bayar di outlet hanya tersedia untuk pembayaran DIRECT'
        });
    }

    const effectiveCustomerId =
        Number(req.user.role_id) === 1
            ? req.user.id
            : customer_id;
    if (!effectiveCustomerId || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
            error: 'customer_id dan items wajib diisi'
        });
    }

    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const customerResult = await client.query(
            'SELECT id FROM tbl_customers WHERE user_id = $1',
            [effectiveCustomerId]
        );

        if (customerResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                error: 'Customer tidak ditemukan'
            });
        }

        const internalCustomerId = customerResult.rows[0].id;
        const validatedItems = [];
        for (const item of items) {
            const quantity = Number(item.quantity || 1);
            if (!item.product_id) {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "product_id wajib diisi" });
            }
            if (!Number.isInteger(quantity) || quantity <= 0) {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "Quantity tidak valid", product_id: item.product_id });
            }
            const productResult = await client.query("SELECT id, merchant_id, sku, name, selling_unit, pack_size_value, pack_size_unit FROM tbl_products WHERE id = $1 AND status = 'ACTIVE' AND customer_visible = TRUE", [item.product_id]);
            if (productResult.rowCount === 0) {
                await client.query("ROLLBACK");
                return res.status(404).json({ error: "Produk tidak ditemukan", product_id: item.product_id });
            }
            const product = productResult.rows[0];

            const stockResult = await client.query(
                `SELECT COALESCE(SUM(quantity_on_hand), 0)::int AS available_stock
                 FROM tbl_inventory
                 WHERE product_id = $1`,
                [product.id]
            );

            const availableStock =
                Number(stockResult.rows[0].available_stock || 0);

            if (availableStock < quantity) {
                await client.query("ROLLBACK");
                return res.status(409).json({
                    error: "Stok tidak mencukupi",
                    product_id: product.id,
                    requested_quantity: quantity,
                    available_stock: availableStock
                });
            }

            const priceResult = await client.query("SELECT amount FROM tbl_product_prices WHERE product_id = $1 AND price_type = 'RETAIL' ORDER BY effective_date DESC LIMIT 1", [product.id]);
            if (priceResult.rowCount === 0) {
                await client.query("ROLLBACK");
                return res.status(400).json({ error: "Harga RETAIL produk belum tersedia", product_id: product.id });
            }
            const unitPrice = Number(priceResult.rows[0].amount);
            const subtotal = unitPrice * quantity;
            validatedItems.push({
                product_id: product.id,
                merchant_id: product.merchant_id,
                sku: product.sku,
                name: product.name,
                selling_unit:
                    String(
                        product.selling_unit || 'PCS'
                    ).toUpperCase(),
                pack_size_value:
                    product.pack_size_value === null ||
                    product.pack_size_value === undefined
                        ? null
                        : Number(
                            product.pack_size_value
                        ),
                pack_size_unit:
                    product.pack_size_unit
                        ? String(
                            product.pack_size_unit
                          ).toUpperCase()
                        : null,
                quantity: quantity,
                unit_price: unitPrice,
                subtotal: subtotal
            });
        }

        const totalAmount = validatedItems.reduce(
            (sum, item) => sum + item.subtotal,
            0
        );

        const merchantIds = [...new Set(validatedItems.map(item => item.merchant_id).filter(Boolean))];

        if (merchantIds.length !== 1) {
            await client.query("ROLLBACK");
            return res.status(400).json({
                error: "Checkout V2 saat ini harus berasal dari satu merchant"
            });
        }

        const merchantId = merchantIds[0];

        let pickupLocationSnapshot = null;

        if (fulfillmentType === 'PICKUP') {
            const merchantResult = await client.query(
                `SELECT
                    id,
                    store_name,
                    address
                 FROM tbl_merchants
                 WHERE id = $1
                   AND status = 'ACTIVE'
                 LIMIT 1`,
                [merchantId]
            );

            if (!merchantResult.rowCount) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error: 'Merchant aktif tidak ditemukan'
                });
            }

            const merchant = merchantResult.rows[0];
            const merchantAddress =
                String(merchant.address || '').trim();

            if (!merchantAddress) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error:
                        'Lokasi pickup merchant belum tersedia. Merchant harus melengkapi alamat outlet terlebih dahulu.'
                });
            }

            pickupLocationSnapshot =
                merchant.store_name + ' - ' + merchantAddress;
        }

        const orderResult = await client.query(
            `INSERT INTO tbl_orders_v2 (
                customer_id,
                merchant_id,
                status,
                shipping_address,
                total_amount,
                fulfillment_type,
                pickup_location_snapshot
             )
             VALUES ($1, $2, 'PENDING', $3, $4, $5, $6)
             RETURNING *`,
            [
                internalCustomerId,
                merchantId,
                fulfillmentType === 'DELIVERY'
                    ? String(shipping_address || '').trim()
                    : null,
                totalAmount,
                fulfillmentType,
                pickupLocationSnapshot
            ]
        );

        const order = orderResult.rows[0];
        for (const item of validatedItems) {
            await client.query(
                `INSERT INTO tbl_order_items (
                    order_id,
                    product_id,
                    quantity,
                    unit_price,
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
                    $7
                 )`,
                [
                    order.id,
                    item.product_id,
                    item.quantity,
                    item.unit_price,
                    item.selling_unit,
                    item.pack_size_value,
                    item.pack_size_unit
                ]
            );
        }


        let responseOrder =
            order;

        let tempoResult =
            null;

        let tempoFulfillment =
            null;

        let outletPayment =
            null;

        /*
         * PICKUP + PAY_AT_OUTLET dibuat atomik bersama Order.
         * Payment masih UNPAID; uang belum dianggap diterima.
         */
        if (
            paymentMode === 'DIRECT' &&
            fulfillmentType === 'PICKUP' &&
            pickupPayment === 'OUTLET'
        ) {
            const outletPaymentResult =
                await client.query(
                    `
                    INSERT INTO tbl_payments (
                        order_id,
                        payment_method,
                        payment_status,
                        amount,
                        gateway_response,
                        provider,
                        channel,
                        external_transaction_id,
                        expires_at,
                        updated_at
                    )
                    VALUES (
                        $1,
                        'PAY_AT_OUTLET',
                        'UNPAID',
                        $2,
                        $3::jsonb,
                        'OUTLET',
                        'PICKUP',
                        NULL,
                        NULL,
                        CURRENT_TIMESTAMP
                    )
                    RETURNING *
                    `,
                    [
                        order.id,
                        order.total_amount,
                        JSON.stringify({
                            type:
                                'PAY_AT_OUTLET',
                            selected_at:
                                new Date().toISOString()
                        })
                    ]
                );

            if (
                outletPaymentResult.rowCount !== 1
            ) {
                throw new Error(
                    'Payment PAY_AT_OUTLET gagal dibuat'
                );
            }

            outletPayment =
                outletPaymentResult.rows[0];
        }

        /*
         * =====================================================
         * DIRECT INVENTORY RESERVATION
         *
         * DIRECT order menahan available stock sebelum COMMIT.
         * TEMPO tidak masuk sini karena fulfillment TEMPO
         * langsung mengurangi physical inventory secara
         * transactional.
         * =====================================================
         */
        let directReservation =
            null;

        if (paymentMode === 'DIRECT') {
            /*
             * Reservation DIRECT mempunyai TTL milik
             * Pasar Pintar sendiri.
             *
             * Jangan bergantung pada expires_at gateway:
             * payment intent belum tentu sudah dibuat
             * pada saat checkout.
             */
            const DIRECT_RESERVATION_TTL_MINUTES =
                30;

            const reservationExpiresAt =
                new Date(
                    Date.now() +
                    DIRECT_RESERVATION_TTL_MINUTES *
                    60 *
                    1000
                );

            const reservationService =
                new OrderInventoryReservationService(
                    client
                );

            directReservation =
                await reservationService
                    .reserveOrder({
                        orderId:
                            order.id,
                        expiresAt:
                            reservationExpiresAt
                    });
        }

        if (paymentMode === 'TEMPO') {
            const receivableService =
                new CustomerReceivableService(
                    client
                );

            tempoResult =
                await receivableService
                    .activateOrderTempo({
                        orderId:
                            order.id,
                        creditAccountId:
                            credit_account_id
                    });

            const inventoryService =
                new OrderInventoryFulfillmentService(
                    client
                );

            tempoFulfillment =
                await inventoryService
                    .fulfillOrderSale({
                        orderId:
                            order.id
                    });

            const packingResult =
                await client.query(
                    `
                    UPDATE tbl_orders_v2
                    SET status = 'PACKING'
                    WHERE id = $1
                      AND payment_mode = 'TEMPO'
                      AND status = 'PENDING'
                    RETURNING *
                    `,
                    [order.id]
                );

            if (!packingResult.rowCount) {
                throw new Error(
                    'Order TEMPO gagal masuk PACKING'
                );
            }

            responseOrder =
                packingResult.rows[0];
        }

        await client.query("COMMIT");

        CommerceKernel.emitEvent(
            "ORDER_CREATED",
            "ORDER",
            responseOrder.id,
            responseOrder
        );

        const responseBody = {
            status: "success",
            message:
                paymentMode === 'TEMPO'
                    ? "Order TEMPO berhasil dibuat"
                    : "Order berhasil dibuat",
            order:
                responseOrder,
            items:
                validatedItems
        };

        if (outletPayment) {
            responseBody.payment =
                outletPayment;
        }

        if (paymentMode === 'TEMPO') {
            responseBody.obligation =
                tempoResult.obligation;

            responseBody.credit =
                tempoResult.credit;

            responseBody.fulfillment = {
                reference_doc:
                    tempoFulfillment.reference_doc,
                movements:
                    tempoFulfillment.movements
            };
        }

        return res
            .status(201)
            .json(responseBody);
    } catch (err) {
        if (client) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {}
        }

        console.error("[CHECKOUT V2]", err.message);

        const businessConflict =
            /limit tempo|tidak ACTIVE|fasilitas tempo|stok tidak mencukupi|sudah memiliki pembayaran|mode pembayaran|harus berstatus PENDING/i
                .test(err.message);

        return res
            .status(
                businessConflict
                    ? 409
                    : 500
            )
            .json({
                error: err.message
            });
    } finally {
        if (client) client.release();
    }
});


router.post(
    '/market/checkout-with-payment-v1',
    verifyToken,
    requireRole(1),
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const checkoutService =
                new MarketCheckoutService(client);

            const checkoutResult =
                await checkoutService.create({
                    userId:
                        req.user.id,
                    items:
                        req.body.items,
                    shippingAddress:
                        req.body.shipping_address,
                    marketCode:
                        req.body.market_code ||
                        'PASAR-SEDERHANA'
                });

            const paymentService =
                new MarketPaymentService(client);

            const paymentResult =
                await paymentService.createPayment({
                    marketOrderId:
                        checkoutResult.market_order.id,
                    userId:
                        req.user.id,
                    paymentMethod:
                        'ONLINE',
                    provider:
                        null,
                    channel:
                        'MARKETPLACE_WEB'
                });

            await client.query('COMMIT');

            return res.status(201).json({
                status:
                    'success',
                message:
                    'Market checkout dan payment berhasil dibuat',
                market:
                    checkoutResult.market,
                market_order:
                    checkoutResult.market_order,
                child_orders:
                    checkoutResult.child_orders.map(
                        child => ({
                            id:
                                child.id,
                            merchant_id:
                                child.merchant_id,
                            store_name:
                                child.store_name,
                            total_amount:
                                child.total_amount,
                            status:
                                child.status
                        })
                    ),
                collector_task:
                    checkoutResult.collector_task,
                collector_stops:
                    checkoutResult.collector_stops,
                payment:
                    paymentResult.payment
            });

        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            console.error(
                '[MARKET CHECKOUT PAYMENT V1]',
                err.message
            );

            const conflict =
                /stok|tidak tersedia|market|quantity|harga retail|payment/i
                    .test(err.message);

            return res
                .status(conflict ? 409 : 500)
                .json({
                    error:
                        err.message
                });

        } finally {
            client.release();
        }
    }
);


router.post(
    '/market/checkout-v1',
    verifyToken,
    requireRole(1),
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const service =
                new MarketCheckoutService(client);

            const result =
                await service.create({
                    userId:
                        req.user.id,
                    items:
                        req.body.items,
                    shippingAddress:
                        req.body.shipping_address,
                    marketCode:
                        req.body.market_code ||
                        'PASAR-SEDERHANA'
                });

            await client.query('COMMIT');

            return res.status(201).json({
                status: 'success',
                message:
                    'Market checkout berhasil dibuat',
                market:
                    result.market,
                market_order:
                    result.market_order,
                child_orders:
                    result.child_orders.map(
                        child => ({
                            id:
                                child.id,
                            merchant_id:
                                child.merchant_id,
                            store_name:
                                child.store_name,
                            total_amount:
                                child.total_amount,
                            status:
                                child.status
                        })
                    ),
                collector_task:
                    result.collector_task,
                collector_stops:
                    result.collector_stops
            });

        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            console.error(
                '[MARKET CHECKOUT V1]',
                err.message
            );

            const conflict =
                /stok|tidak tersedia|market|quantity|harga retail/i
                    .test(err.message);

            return res
                .status(conflict ? 409 : 500)
                .json({
                    error:
                        err.message
                });

        } finally {
            client.release();
        }
    }
);


router.post(
    '/market/payments',
    verifyToken,
    requireRole(1),
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const service =
                new MarketPaymentService(client);

            const result =
                await service.createPayment({
                    marketOrderId:
                        req.body.market_order_id,
                    userId:
                        req.user.id,
                    paymentMethod:
                        req.body.payment_method,
                    provider:
                        req.body.provider || null,
                    channel:
                        req.body.channel || null,
                    externalTransactionId:
                        req.body.external_transaction_id || null,
                    expiresAt:
                        req.body.expires_at || null
                });

            await client.query('COMMIT');

            return res.status(
                result.status === 'created'
                    ? 201
                    : 200
            ).json({
                status: 'success',
                result_status:
                    result.status,
                payment:
                    result.payment,
                market_order:
                    result.market_order
            });

        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            console.error(
                '[MARKET PAYMENT CREATE]',
                err.message
            );

            return res.status(409).json({
                error: err.message
            });

        } finally {
            client.release();
        }
    }
);


router.post(
    '/market/payments/:id/confirm',
    verifyToken,
    requireRole(4),
    async (req, res) => {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const service =
                new MarketPaymentService(client);

            const result =
                await service.confirmPaid({
                    marketPaymentId:
                        req.params.id,
                    confirmedBy:
                        req.user.username ||
                        req.user.id,
                    gatewayResponse: {
                        source:
                            'INTERNAL_ADMIN_CONFIRM'
                    }
                });

            await client.query('COMMIT');

            for (
                const event of
                result.events || []
            ) {
                CommerceKernel.emitEvent(
                    'ORDER_PAID',
                    'ORDER',
                    event.order_id,
                    event.payload
                );
            }

            return res.json({
                status: 'success',
                result_status:
                    result.status,
                market_payment:
                    result.market_payment,
                market_order:
                    result.market_order,
                event_count:
                    (result.events || []).length
            });

        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            console.error(
                '[MARKET PAYMENT CONFIRM]',
                err.message
            );

            return res.status(409).json({
                error: err.message
            });

        } finally {
            client.release();
        }
    }
);


// ============================================================
// CUSTOMER MARKET ORDERS V1
// Parent order customer untuk transaksi lintas jongko.
// ============================================================
router.get(
    '/market/orders/my',
    verifyToken,
    requireRole(1, 4),
    async (req, res) => {
        try {
            let userId = req.user.id;

            if (
                Number(req.user.role_id) === 4 &&
                req.query.user_id
            ) {
                userId = req.query.user_id;
            }

            const customerResult =
                await pool.query(
                    `SELECT id
                     FROM tbl_customers
                     WHERE user_id = $1
                     LIMIT 1`,
                    [userId]
                );

            if (customerResult.rowCount === 0) {
                return res.status(404).json({
                    error: 'Customer tidak ditemukan'
                });
            }

            const customerId =
                customerResult.rows[0].id;

            const result = await pool.query(
                `SELECT
                    mo.id,
                    'MARKET'::text AS order_type,
                    mk.id AS market_id,
                    mk.name AS market_name,
                    mk.code AS market_code,
                    mo.status,
                    mo.fulfillment_type,
                    mo.shipping_address,
                    mo.total_amount,
                    mo.created_at,

                    pay.id AS payment_id,
                    pay.payment_method,
                    pay.payment_status,
                    pay.amount AS payment_amount,
                    pay.provider AS payment_provider,

                    ct.id AS collector_task_id,
                    ct.status AS collector_status,

                    COALESCE(
                        child.merchant_count,
                        0
                    ) AS merchant_count,

                    COALESCE(
                        item_data.items,
                        '[]'::json
                    ) AS items

                 FROM tbl_market_orders mo

                 INNER JOIN tbl_markets mk
                    ON mk.id = mo.market_id

                 LEFT JOIN LATERAL (
                    SELECT
                        mp.id,
                        mp.payment_method,
                        mp.payment_status,
                        mp.amount,
                        mp.provider
                    FROM tbl_market_payments mp
                    WHERE mp.market_order_id = mo.id
                    ORDER BY mp.created_at DESC
                    LIMIT 1
                 ) pay ON TRUE

                 LEFT JOIN tbl_collector_tasks ct
                    ON ct.market_order_id = mo.id

                 LEFT JOIN LATERAL (
                    SELECT
                        COUNT(
                            DISTINCT o.merchant_id
                        )::int AS merchant_count
                    FROM tbl_orders_v2 o
                    WHERE o.market_order_id = mo.id
                 ) child ON TRUE

                 LEFT JOIN LATERAL (
                    SELECT
                        json_agg(
                            json_build_object(
                                'id', oi.id,
                                'child_order_id', o.id,
                                'merchant_id', o.merchant_id,
                                'store_name', m.store_name,
                                'product_id', oi.product_id,
                                'product_name', p.name,
                                'sku', p.sku,
                                'quantity', oi.quantity,
                                'unit_price', oi.unit_price,
                                'selling_unit_snapshot',
                                    oi.selling_unit_snapshot,
                                'pack_size_value_snapshot',
                                    oi.pack_size_value_snapshot,
                                'pack_size_unit_snapshot',
                                    oi.pack_size_unit_snapshot
                            )
                            ORDER BY
                                m.store_name,
                                p.name
                        ) AS items
                    FROM tbl_orders_v2 o
                    INNER JOIN tbl_order_items oi
                        ON oi.order_id = o.id
                    INNER JOIN tbl_products p
                        ON p.id = oi.product_id
                    INNER JOIN tbl_merchants m
                        ON m.id = o.merchant_id
                    WHERE o.market_order_id = mo.id
                 ) item_data ON TRUE

                 WHERE mo.customer_id = $1

                 ORDER BY mo.created_at DESC`,
                [customerId]
            );

            return res.json({
                status: 'success',
                data: result.rows
            });

        } catch (err) {
            console.error(
                '[MY MARKET ORDERS]',
                err.message
            );

            return res.status(500).json({
                error: err.message
            });
        }
    }
);

module.exports = router;
