const { validatePilotDeliveryAddress } =
    require('../delivery/DeliveryAreaPolicy');

class WhatsAppOrderConfirmationService {
    constructor(pool, CommerceKernel = null) {
        this.pool = pool;
        this.CommerceKernel = CommerceKernel;
    }

    async confirm({ customerId }) {
        if (!customerId) {
            const err = new Error('customerId wajib tersedia');
            err.code = 'CUSTOMER_REQUIRED';
            throw err;
        }

        const client = await this.pool.connect();

        let committedOrder = null;

        try {
            await client.query('BEGIN');

            /*
             * Lock draft agar dua request KONFIRMASI paralel
             * tidak dapat membuat dua order.
             */
            const draftResult = await client.query(
                `
                SELECT
                    d.id,
                    d.customer_id,
                    d.product_id,
                    d.quantity,
                    d.unit_price,
                    d.subtotal,
                    d.selling_unit_snapshot,
                    d.pack_size_value_snapshot,
                    d.pack_size_unit_snapshot,
                    d.fulfillment_type,
                    d.fulfillment_selection_explicit,
                    d.pickup_payment,
                    d.delivery_payment,
                    d.pickup_location_snapshot,
                    d.shipping_address,
                    d.status,
                    d.expires_at,
                    d.confirmed_order_id
                FROM tbl_whatsapp_order_drafts d
                WHERE d.customer_id = $1
                  AND d.status = 'PENDING_CONFIRMATION'
                ORDER BY d.created_at DESC
                LIMIT 1
                FOR UPDATE
                `,
                [customerId]
            );

            if (draftResult.rowCount === 0) {
                await client.query('ROLLBACK');

                return {
                    status: 'draft_not_found',
                    order: null
                };
            }

            const draft = draftResult.rows[0];

            if (
                new Date(draft.expires_at).getTime() <=
                Date.now()
            ) {
                await client.query(
                    `
                    UPDATE tbl_whatsapp_order_drafts
                    SET status = 'EXPIRED'
                    WHERE id = $1
                    `,
                    [draft.id]
                );

                await client.query('COMMIT');

                return {
                    status: 'draft_expired',
                    order: null
                };
            }

            const fulfillmentType =
                String(
                    draft.fulfillment_type ||
                    'DELIVERY'
                )
                    .trim()
                    .toUpperCase();

            const fulfillmentSelectionExplicit =
                draft.fulfillment_selection_explicit ===
                true;

            /*
             * =====================================================
             * EXPLICIT FULFILLMENT SELECTION
             *
             * fulfillment_type mempunyai default DELIVERY untuk
             * backward compatibility database, tetapi draft baru
             * tidak boleh dikonfirmasi sebelum Customer benar-benar
             * memilih DELIVERY atau PICKUP.
             * =====================================================
             */
            if (
                !fulfillmentSelectionExplicit
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'fulfillment_selection_required',
                    order:
                        null
                };
            }

            const pickupPayment =
                draft.pickup_payment
                    ? String(
                        draft.pickup_payment
                      )
                        .trim()
                        .toUpperCase()
                    : null;

            const deliveryPayment =
                draft.delivery_payment
                    ? String(
                        draft.delivery_payment
                      )
                        .trim()
                        .toUpperCase()
                    : null;

            const pickupLocationSnapshot =
                draft.pickup_location_snapshot
                    ? String(
                        draft.pickup_location_snapshot
                      ).trim()
                    : null;

            if (
                ![
                    'DELIVERY',
                    'PICKUP'
                ].includes(
                    fulfillmentType
                )
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'invalid_fulfillment_type',
                    order: null
                };
            }

            if (
                fulfillmentType ===
                    'DELIVERY'
            ) {
                const deliveryArea =
                    validatePilotDeliveryAddress(
                        draft.shipping_address
                    );

                if (!deliveryArea.ok) {
                    await client.query(
                        'ROLLBACK'
                    );

                    return {
                        status:
                            deliveryArea.code ===
                            'SHIPPING_ADDRESS_REQUIRED'
                                ? 'shipping_address_required'
                                : 'delivery_area_not_supported',
                        code:
                            deliveryArea.code,
                        order: null
                    };
                }
            }

            if (
                fulfillmentType ===
                    'PICKUP' &&
                !pickupLocationSnapshot
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'pickup_location_required',
                    order: null
                };
            }

            /*
             * PICKUP membutuhkan pilihan pembayaran eksplisit.
             * Jangan membuat Order bila Customer baru memilih
             * ambil sendiri tetapi belum memilih cara bayar.
             */
            /*
             * =====================================================
             * DELIVERY PAYMENT SELECTION
             *
             * DELIVERY membutuhkan pilihan pembayaran eksplisit
             * sebelum Order dibuat.
             *
             * Saat ini conversational DELIVERY hanya mendukung
             * ONLINE.
             * =====================================================
             */
            if (
                fulfillmentType ===
                    'DELIVERY' &&
                !deliveryPayment
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'delivery_payment_required',
                    order:
                        null
                };
            }

            if (
                fulfillmentType ===
                    'DELIVERY' &&
                deliveryPayment !==
                    'ONLINE'
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'invalid_delivery_payment',
                    order:
                        null
                };
            }

            if (
                fulfillmentType ===
                    'PICKUP' &&
                !pickupPayment
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'pickup_payment_required',
                    order:
                        null
                };
            }

            if (
                fulfillmentType ===
                    'PICKUP' &&
                pickupPayment !== null &&
                ![
                    'ONLINE',
                    'OUTLET'
                ].includes(
                    pickupPayment
                )
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'invalid_pickup_payment',
                    order: null
                };
            }

            /*
             * Product canonical.
             */
            const productResult = await client.query(
                `
                SELECT
                    id,
                    merchant_id,
                    sku,
                    name
                FROM tbl_products
                WHERE id = $1
                  AND status = 'ACTIVE'
                LIMIT 1
                `,
                [draft.product_id]
            );

            if (productResult.rowCount === 0) {
                await client.query('ROLLBACK');

                return {
                    status: 'product_unavailable',
                    order: null
                };
            }

            const product = productResult.rows[0];

            if (!product.merchant_id) {
                await client.query('ROLLBACK');

                return {
                    status: 'merchant_missing',
                    order: null
                };
            }

            /*
             * Revalidate current stock.
             * Sama seperti checkoutV2: validasi saja,
             * belum melakukan pengurangan stok.
             */
            const stockResult = await client.query(
                `
                SELECT
                    COALESCE(
                        SUM(quantity_on_hand),
                        0
                    )::int AS stock
                FROM tbl_inventory
                WHERE product_id = $1
                `,
                [product.id]
            );

            const stock =
                Number(stockResult.rows[0]?.stock || 0);

            const quantity =
                Number(draft.quantity);

            if (stock < quantity) {
                await client.query('ROLLBACK');

                return {
                    status: 'insufficient_stock',
                    availableStock: stock,
                    requestedQuantity: quantity,
                    order: null
                };
            }

            /*
             * Revalidate retail price.
             */
            const priceResult = await client.query(
                `
                SELECT amount
                FROM tbl_product_prices
                WHERE product_id = $1
                  AND price_type = 'RETAIL'
                ORDER BY effective_date DESC
                LIMIT 1
                `,
                [product.id]
            );

            if (priceResult.rowCount === 0) {
                await client.query('ROLLBACK');

                return {
                    status: 'price_unavailable',
                    order: null
                };
            }

            const currentPrice =
                Number(priceResult.rows[0].amount);

            const draftPrice =
                Number(draft.unit_price);

            if (currentPrice !== draftPrice) {
                await client.query('ROLLBACK');

                return {
                    status: 'price_changed',
                    currentPrice,
                    draftPrice,
                    order: null
                };
            }

            const subtotal =
                currentPrice * quantity;

            if (
                subtotal !==
                Number(draft.subtotal)
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'subtotal_mismatch',
                    order: null
                };
            }

            /*
             * Create canonical order.
             */
            const orderResult = await client.query(
                `
                INSERT INTO tbl_orders_v2 (
                    customer_id,
                    merchant_id,
                    status,
                    shipping_address,
                    total_amount,
                    fulfillment_type,
                    pickup_location_snapshot,
                    payment_mode
                )
                VALUES (
                    $1,
                    $2,
                    'PENDING',
                    $3,
                    $4,
                    $5,
                    $6,
                    'DIRECT'
                )
                RETURNING
                    id,
                    customer_id,
                    merchant_id,
                    status,
                    shipping_address,
                    total_amount,
                    fulfillment_type,
                    pickup_location_snapshot,
                    payment_mode,
                    created_at
                `,
                [
                    customerId,
                    product.merchant_id,
                    fulfillmentType ===
                        'DELIVERY'
                        ? String(
                            draft.shipping_address ||
                            ''
                          ).trim()
                        : null,
                    subtotal,
                    fulfillmentType,
                    fulfillmentType ===
                        'PICKUP'
                        ? pickupLocationSnapshot
                        : null
                ]
            );

            const order = orderResult.rows[0];

            /*
             * =====================================================
             * WHATSAPP PICKUP + PAY AT OUTLET
             *
             * Sama dengan canonical checkoutV2:
             *
             * - Order dan Payment dibuat dalam transaction yang sama.
             * - Payment dimulai sebagai UNPAID.
             * - Uang belum dianggap diterima.
             * - Merchant tetap harus memakai canonical
             *   confirm-outlet-payment untuk mengubahnya menjadi PAID.
             * =====================================================
             */
            let outletPayment = null;

            if (
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
                                source:
                                    'WHATSAPP',
                                selected_at:
                                    new Date().toISOString()
                            })
                        ]
                    );

                if (
                    outletPaymentResult.rowCount !== 1
                ) {
                    throw new Error(
                        'Payment PAY_AT_OUTLET WhatsApp gagal dibuat'
                    );
                }

                outletPayment =
                    outletPaymentResult.rows[0];
            }

            await client.query(
                `
                INSERT INTO tbl_order_items (
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
                )
                `,
                [
                    order.id,
                    product.id,
                    quantity,
                    currentPrice,
                    String(
                        draft.selling_unit_snapshot || 'PCS'
                    ).toUpperCase(),
                    draft.pack_size_value_snapshot === null ||
                    draft.pack_size_value_snapshot === undefined
                        ? null
                        : Number(
                            draft.pack_size_value_snapshot
                        ),
                    draft.pack_size_unit_snapshot
                        ? String(
                            draft.pack_size_unit_snapshot
                          ).toUpperCase()
                        : null
                ]
            );

            /*
             * Draft menjadi immutable confirmation record.
             */
            const draftUpdate = await client.query(
                `
                UPDATE tbl_whatsapp_order_drafts
                SET
                    status = 'CONFIRMED',
                    confirmed_at = CURRENT_TIMESTAMP,
                    confirmed_order_id = $1
                WHERE id = $2
                  AND status = 'PENDING_CONFIRMATION'
                RETURNING id
                `,
                [
                    order.id,
                    draft.id
                ]
            );

            if (draftUpdate.rowCount !== 1) {
                throw new Error(
                    'Draft confirmation state berubah secara tidak terduga'
                );
            }

            await client.query('COMMIT');

            committedOrder = {
                ...order,

                /*
                 * Conversational payment selection metadata.
                 *
                 * Field ini bukan canonical tbl_orders_v2 column.
                 * Hanya digunakan setelah COMMIT oleh Orchestrator
                 * untuk menentukan apakah payment intent ONLINE
                 * harus dilanjutkan.
                 */
                paymentSelection:
                    fulfillmentType === 'PICKUP'
                        ? pickupPayment
                        : (
                            fulfillmentType === 'DELIVERY'
                                ? deliveryPayment
                                : null
                          ),

                payment:
                    outletPayment
                        ? {
                            id:
                                outletPayment.id,
                            provider:
                                outletPayment.provider,
                            paymentMethod:
                                outletPayment.payment_method,
                            paymentStatus:
                                outletPayment.payment_status,
                            amount:
                                Number(
                                    outletPayment.amount
                                ),
                            channel:
                                outletPayment.channel
                        }
                        : null,
                product: {
                    id: product.id,
                    sku: product.sku,
                    name: product.name,
                    quantity,
                    unitPrice: currentPrice,
                    sellingUnit:
                        String(
                            draft.selling_unit_snapshot || 'PCS'
                        ).toUpperCase(),
                    packSizeValue:
                        draft.pack_size_value_snapshot === null ||
                        draft.pack_size_value_snapshot === undefined
                            ? null
                            : Number(
                                draft.pack_size_value_snapshot
                            ),
                    packSizeUnit:
                        draft.pack_size_unit_snapshot
                            ? String(
                                draft.pack_size_unit_snapshot
                              ).toUpperCase()
                            : null
                }
            };
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {
                // Ignore secondary rollback error.
            }

            throw err;
        } finally {
            client.release();
        }

        /*
         * Event hanya diterbitkan SETELAH COMMIT berhasil.
         */
        if (
            committedOrder &&
            this.CommerceKernel
        ) {
            this.CommerceKernel.emitEvent(
                'ORDER_CREATED',
                'ORDER',
                committedOrder.id,
                committedOrder
            );
        }

        return {
            status: 'confirmed',
            order: committedOrder
        };
    }
}

module.exports = WhatsAppOrderConfirmationService;
