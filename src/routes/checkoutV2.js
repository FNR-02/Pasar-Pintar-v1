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
// Katalog Produk untuk Customer
router.get(
    '/catalog/products',
    verifyToken,
    requireRole(1, 4),
    async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT
                    p.id,
                    p.merchant_id,
                    p.sku,
                    p.name,
                    p.description,
                    p.image_url,
                    m.store_name,
                    m.address AS merchant_address,
                    COALESCE(price.amount, 0) AS price,
                    COALESCE(inv.stock, 0) AS stock
                FROM tbl_products p
                LEFT JOIN tbl_merchants m
                    ON m.id = p.merchant_id
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
                ORDER BY p.created_at DESC
            `);

            return res.json({
                status: 'success',
                count: result.rowCount,
                data: result.rows
            });
        } catch (err) {
            console.error('[CUSTOMER CATALOG ERROR]', err.message);

            return res.status(500).json({
                error: err.message
            });
        }
    }
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
            const productResult = await client.query("SELECT id, merchant_id, sku, name, selling_unit FROM tbl_products WHERE id = $1 AND status = 'ACTIVE'", [item.product_id]);
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
                    selling_unit_snapshot
                 )
                 VALUES ($1, $2, $3, $4, $5)`,
                [
                    order.id,
                    item.product_id,
                    item.quantity,
                    item.unit_price,
                    item.selling_unit
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

module.exports = router;
