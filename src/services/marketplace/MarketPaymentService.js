const OrderInventoryFulfillmentService =
    require('../orders/OrderInventoryFulfillmentService');

const OrderInventoryReservationService =
    require('../orders/OrderInventoryReservationService');

const OrderFSM =
    require('../../kernel/OrderFSM');

class MarketPaymentService {
    constructor(db) {
        this.db = db;
    }

    async createPayment({
        marketOrderId,
        userId,
        paymentMethod,
        provider = null,
        channel = null,
        externalTransactionId = null,
        expiresAt = null
    }) {
        if (!marketOrderId) {
            throw new Error(
                'market_order_id wajib'
            );
        }

        if (!userId) {
            throw new Error(
                'user_id wajib'
            );
        }

        if (!paymentMethod) {
            throw new Error(
                'payment_method wajib'
            );
        }

        const customerResult =
            await this.db.query(
                `
                SELECT id
                FROM tbl_customers
                WHERE user_id = $1
                `,
                [userId]
            );

        if (!customerResult.rowCount) {
            throw new Error(
                'Customer tidak ditemukan'
            );
        }

        const customerId =
            customerResult.rows[0].id;

        const orderResult =
            await this.db.query(
                `
                SELECT *
                FROM tbl_market_orders
                WHERE id = $1
                  AND customer_id = $2
                FOR UPDATE
                `,
                [
                    marketOrderId,
                    customerId
                ]
            );

        if (!orderResult.rowCount) {
            throw new Error(
                'Market order tidak ditemukan'
            );
        }

        const marketOrder =
            orderResult.rows[0];

        if (
            marketOrder.status !==
            'PENDING'
        ) {
            throw new Error(
                `Market order tidak berada pada status PENDING: ${marketOrder.status}`
            );
        }

        const existingResult =
            await this.db.query(
                `
                SELECT *
                FROM tbl_market_payments
                WHERE market_order_id = $1
                  AND payment_status IN (
                      'UNPAID',
                      'PAID'
                  )
                ORDER BY created_at DESC
                LIMIT 1
                FOR UPDATE
                `,
                [marketOrder.id]
            );

        if (existingResult.rowCount) {
            return {
                status:
                    'existing',
                payment:
                    existingResult.rows[0],
                market_order:
                    marketOrder
            };
        }

        const amount =
            Number(
                marketOrder.total_amount
            );

        if (
            !Number.isFinite(amount) ||
            amount < 0
        ) {
            throw new Error(
                'Total market order tidak valid'
            );
        }

        const paymentResult =
            await this.db.query(
                `
                INSERT INTO tbl_market_payments (
                    market_order_id,
                    payment_method,
                    payment_status,
                    amount,
                    provider,
                    channel,
                    external_transaction_id,
                    expires_at
                )
                VALUES (
                    $1,
                    $2,
                    'UNPAID',
                    $3,
                    $4,
                    $5,
                    $6,
                    $7
                )
                RETURNING *
                `,
                [
                    marketOrder.id,
                    paymentMethod,
                    amount,
                    provider,
                    channel,
                    externalTransactionId,
                    expiresAt
                ]
            );

        return {
            status:
                'created',
            payment:
                paymentResult.rows[0],
            market_order:
                marketOrder
        };
    }

    async confirmPaid({
        marketPaymentId,
        confirmedBy = 'SYSTEM',
        gatewayResponse = {}
    }) {
        if (!marketPaymentId) {
            throw new Error(
                'market_payment_id wajib'
            );
        }

        const paymentResult =
            await this.db.query(
                `
                SELECT *
                FROM tbl_market_payments
                WHERE id = $1
                FOR UPDATE
                `,
                [marketPaymentId]
            );

        if (!paymentResult.rowCount) {
            throw new Error(
                'Market payment tidak ditemukan'
            );
        }

        const marketPayment =
            paymentResult.rows[0];

        const marketOrderResult =
            await this.db.query(
                `
                SELECT *
                FROM tbl_market_orders
                WHERE id = $1
                FOR UPDATE
                `,
                [
                    marketPayment.market_order_id
                ]
            );

        if (!marketOrderResult.rowCount) {
            throw new Error(
                'Market order tidak ditemukan'
            );
        }

        const marketOrder =
            marketOrderResult.rows[0];

        const childrenResult =
            await this.db.query(
                `
                SELECT *
                FROM tbl_orders_v2
                WHERE market_order_id = $1
                ORDER BY merchant_id, id
                FOR UPDATE
                `,
                [marketOrder.id]
            );

        if (!childrenResult.rowCount) {
            throw new Error(
                'Market order tidak memiliki child order'
            );
        }

        const children =
            childrenResult.rows;

        const parentAmount =
            Number(
                marketOrder.total_amount
            );

        const paymentAmount =
            Number(
                marketPayment.amount
            );

        const childTotal =
            children.reduce(
                (sum, child) =>
                    sum +
                    Number(
                        child.total_amount
                    ),
                0
            );

        if (
            !Number.isFinite(parentAmount) ||
            !Number.isFinite(paymentAmount) ||
            !Number.isFinite(childTotal) ||
            parentAmount !== paymentAmount ||
            parentAmount !== childTotal
        ) {
            throw new Error(
                'Nominal parent payment tidak sesuai dengan total child order'
            );
        }

        if (
            marketPayment.payment_status ===
            'PAID'
        ) {
            if (
                marketOrder.status !==
                'COLLECTING'
            ) {
                throw new Error(
                    'Market payment PAID tetapi market order belum COLLECTING'
                );
            }

            for (const child of children) {
                if (
                    child.status !==
                    'PACKING'
                ) {
                    throw new Error(
                        `Market payment PAID tetapi child ${child.id} belum PACKING`
                    );
                }

                const expectedExternalId =
                    `MARKET-${marketPayment.id}-${child.id}`;

                const auditResult =
                    await this.db.query(
                        `
                        SELECT
                            (
                                SELECT COUNT(*)::int
                                FROM tbl_payments p
                                WHERE p.order_id = $1
                                  AND p.payment_status = 'PAID'
                                  AND p.external_transaction_id = $2
                                  AND p.amount = $3
                                  AND p.gateway_response->>'market_payment_id' = $4
                            ) AS payment_count,

                            EXISTS (
                                SELECT 1
                                FROM tbl_inventory_movements im
                                WHERE im.reference_doc = $5
                                  AND im.movement_type = 'SALE'
                            ) AS sale_exists,

                            EXISTS (
                                SELECT 1
                                FROM tbl_inventory_reservations r
                                WHERE r.order_id = $1
                                  AND r.status = 'RESERVED'
                            ) AS reserved_exists
                        `,
                        [
                            child.id,
                            expectedExternalId,
                            child.total_amount,
                            marketPayment.id,
                            `ORD-${child.id}`
                        ]
                    );

                const audit =
                    auditResult.rows[0];

                if (
                    Number(
                        audit.payment_count
                    ) !== 1
                ) {
                    throw new Error(
                        `Market payment PAID tetapi child payment ${child.id} tidak lengkap`
                    );
                }

                if (!audit.sale_exists) {
                    throw new Error(
                        `Market payment PAID tetapi SALE ${child.id} tidak ditemukan`
                    );
                }

                if (audit.reserved_exists) {
                    throw new Error(
                        `Market payment PAID tetapi reservation ${child.id} masih RESERVED`
                    );
                }
            }

            return {
                status:
                    'already_confirmed',
                market_payment:
                    marketPayment,
                market_order:
                    marketOrder,
                child_orders:
                    children,
                events:
                    []
            };
        }

        if (
            marketPayment.payment_status !==
            'UNPAID'
        ) {
            throw new Error(
                `Market payment tidak berada pada status UNPAID: ${marketPayment.payment_status}`
            );
        }

        if (
            marketOrder.status !==
            'PENDING'
        ) {
            throw new Error(
                `Market order tidak berada pada status PENDING: ${marketOrder.status}`
            );
        }

        for (const child of children) {
            if (
                child.status !==
                'PENDING'
            ) {
                throw new Error(
                    `Child order ${child.id} tidak berada pada status PENDING`
                );
            }

            if (
                child.payment_mode !==
                'DIRECT'
            ) {
                throw new Error(
                    `Child order ${child.id} bukan DIRECT`
                );
            }
        }

        const events = [];
        const finalChildren = [];

        const inventoryService =
            new OrderInventoryFulfillmentService(
                this.db
            );

        const reservationService =
            new OrderInventoryReservationService(
                this.db
            );

        for (const child of children) {
            OrderFSM.assertTransition(
                child.status,
                'PAID'
            );

            const childPaymentResult =
                await this.db.query(
                    `
                    INSERT INTO tbl_payments (
                        order_id,
                        payment_method,
                        payment_status,
                        amount,
                        gateway_response,
                        provider,
                        channel,
                        external_transaction_id
                    )
                    VALUES (
                        $1,
                        $2,
                        'PAID',
                        $3,
                        $4::jsonb,
                        $5,
                        $6,
                        $7
                    )
                    RETURNING *
                    `,
                    [
                        child.id,
                        marketPayment.payment_method,
                        child.total_amount,
                        JSON.stringify({
                            source:
                                'MARKET_PARENT',
                            market_order_id:
                                marketOrder.id,
                            market_payment_id:
                                marketPayment.id
                        }),
                        marketPayment.provider,
                        marketPayment.channel,
                        `MARKET-${marketPayment.id}-${child.id}`
                    ]
                );

            const childPayment =
                childPaymentResult.rows[0];

            const paidResult =
                await this.db.query(
                    `
                    UPDATE tbl_orders_v2
                    SET status = 'PAID'
                    WHERE id = $1
                      AND status = 'PENDING'
                    RETURNING *
                    `,
                    [child.id]
                );

            if (
                paidResult.rowCount !== 1
            ) {
                throw new Error(
                    `Child order ${child.id} gagal masuk PAID`
                );
            }

            const fulfillment =
                await inventoryService
                    .fulfillOrderSale({
                        orderId:
                            child.id
                    });

            const consumeResult =
                await reservationService
                    .consumeOrder({
                        orderId:
                            child.id
                    });

            if (
                ![
                    'consumed',
                    'already_consumed',
                    'nothing_to_consume'
                ].includes(
                    consumeResult.status
                )
            ) {
                throw new Error(
                    `Reservation consume gagal untuk ${child.id}: ${consumeResult.status}`
                );
            }

            OrderFSM.assertTransition(
                'PAID',
                'PACKING'
            );

            const packingResult =
                await this.db.query(
                    `
                    UPDATE tbl_orders_v2
                    SET status = 'PACKING'
                    WHERE id = $1
                      AND status = 'PAID'
                    RETURNING *
                    `,
                    [child.id]
                );

            if (
                packingResult.rowCount !== 1
            ) {
                throw new Error(
                    `Child order ${child.id} gagal masuk PACKING`
                );
            }

            const finalOrder =
                packingResult.rows[0];

            finalChildren.push(
                finalOrder
            );

            const orderPaidPayload = {
                version:
                    'v2',
                ...finalOrder,

                orderId:
                    finalOrder.id,

                order_reference:
                    finalOrder.id,

                payment_id:
                    childPayment.id,

                payment_method:
                    childPayment.payment_method,

                payment_status:
                    childPayment.payment_status,

                provider:
                    childPayment.provider,

                amount:
                    childPayment.amount,

                inventory_reference:
                    fulfillment.reference_doc,

                reservation_status:
                    consumeResult.status,

                market_order_id:
                    marketOrder.id,

                market_payment_id:
                    marketPayment.id,

                atomic_fulfillment:
                    true,

                atomic_market_fulfillment:
                    true
            };

            await this.db.query(
                `
                INSERT INTO tbl_order_paid_outbox (
                    order_id,
                    payload
                )
                VALUES (
                    $1,
                    $2::jsonb
                )
                ON CONFLICT (order_id)
                DO NOTHING
                `,
                [
                    finalOrder.id,
                    JSON.stringify(
                        orderPaidPayload
                    )
                ]
            );

            events.push({
                order_id:
                    finalOrder.id,
                payload:
                    orderPaidPayload
            });
        }

        const updatedPaymentResult =
            await this.db.query(
                `
                UPDATE tbl_market_payments
                SET
                    payment_status =
                        'PAID',
                    gateway_response =
                        COALESCE(
                            gateway_response,
                            '{}'::jsonb
                        ) ||
                        $2::jsonb,
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE id = $1
                  AND payment_status =
                        'UNPAID'
                RETURNING *
                `,
                [
                    marketPayment.id,
                    JSON.stringify({
                        ...gatewayResponse,
                        confirmed_at:
                            new Date()
                                .toISOString(),
                        confirmed_by:
                            confirmedBy
                    })
                ]
            );

        if (
            updatedPaymentResult.rowCount !==
            1
        ) {
            throw new Error(
                'Market payment berubah secara bersamaan'
            );
        }

        const updatedMarketOrderResult =
            await this.db.query(
                `
                UPDATE tbl_market_orders
                SET
                    status =
                        'COLLECTING',
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE id = $1
                  AND status =
                        'PENDING'
                RETURNING *
                `,
                [marketOrder.id]
            );

        if (
            updatedMarketOrderResult.rowCount !==
            1
        ) {
            throw new Error(
                'Market order gagal masuk COLLECTING'
            );
        }

        return {
            status:
                'confirmed',
            market_payment:
                updatedPaymentResult.rows[0],
            market_order:
                updatedMarketOrderResult.rows[0],
            child_orders:
                finalChildren,
            events
        };
    }
}

module.exports =
    MarketPaymentService;
