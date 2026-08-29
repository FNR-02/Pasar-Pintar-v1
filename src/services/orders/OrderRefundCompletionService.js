const OrderFSM = require('../../kernel/OrderFSM');

class OrderRefundCompletionService {
    constructor(pool) {
        this.pool = pool;
    }

    async completeRefund({
        refundId,
        adminUserId
    }) {
        if (!refundId || !adminUserId) {
            return {
                status: 'invalid_input'
            };
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            /*
             * Lock refund terlebih dahulu.
             *
             * Hanya refund PENDING yang boleh diselesaikan.
             */
            const refundResult =
                await client.query(
                    `
                    SELECT *
                    FROM tbl_order_refunds
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [refundId]
                );

            if (!refundResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status: 'refund_not_found'
                };
            }

            const refund =
                refundResult.rows[0];

            const refundStatus =
                String(
                    refund.status || ''
                ).toUpperCase();

            /*
             * Retry setelah refund berhasil diselesaikan
             * harus bersifat idempotent.
             *
             * Tidak ada side effect yang dijalankan ulang.
             */
            if (refundStatus === 'COMPLETED') {
                await client.query('ROLLBACK');

                return {
                    status: 'success',
                    already_completed: true,
                    refund
                };
            }

            if (refundStatus !== 'PENDING') {
                await client.query('ROLLBACK');

                return {
                    status: 'refund_not_pending',
                    current_status:
                        refund.status
                };
            }

            /*
             * Lock order yang menjadi pemilik refund.
             */
            const orderResult =
                await client.query(
                    `
                    SELECT
                        id,
                        customer_id,
                        status,
                        payment_mode,
                        total_amount
                    FROM tbl_orders_v2
                    WHERE id = $1
                    FOR UPDATE
                    `,
                    [refund.order_id]
                );

            if (!orderResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status: 'order_not_found'
                };
            }

            const order =
                orderResult.rows[0];

            /*
             * Refund V1 hanya berlaku untuk DIRECT payment.
             */
            if (
                String(
                    order.payment_mode || ''
                ).toUpperCase() !== 'DIRECT'
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'order_not_direct'
                };
            }

            const orderStatus =
                String(
                    order.status || ''
                ).toUpperCase();

            /*
             * FSM menjadi source of truth lifecycle order.
             *
             * Saat ini hanya:
             * PAID    -> REFUNDED
             * PACKING -> REFUNDED
             */
            if (
                !OrderFSM.canTransition(
                    orderStatus,
                    'REFUNDED'
                )
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'order_not_refundable',
                    current_status:
                        order.status
                };
            }

            /*
             * Payment yang direfund harus payment persis
             * yang direferensikan refund.
             *
             * Payment tetap PAID setelah refund selesai.
             * History bahwa uang pernah diterima tidak
             * boleh dihapus atau ditimpa.
             */
            const paymentResult =
                await client.query(
                    `
                    SELECT
                        id,
                        order_id,
                        payment_status,
                        payment_method,
                        provider,
                        channel,
                        amount,
                        external_transaction_id,
                        (amount = $3::numeric)
                            AS amount_matches_refund,
                        (amount = $4::numeric)
                            AS amount_matches_order
                    FROM tbl_payments
                    WHERE id = $1
                      AND order_id = $2
                    FOR UPDATE
                    `,
                    [
                        refund.payment_id,
                        order.id,
                        refund.amount,
                        order.total_amount
                    ]
                );

            if (!paymentResult.rowCount) {
                await client.query('ROLLBACK');

                return {
                    status: 'payment_not_found'
                };
            }

            const payment =
                paymentResult.rows[0];

            if (
                String(
                    payment.payment_status || ''
                ).toUpperCase() !== 'PAID'
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'payment_not_paid',
                    current_status:
                        payment.payment_status
                };
            }

            if (
                payment.amount_matches_refund !== true ||
                payment.amount_matches_order !== true
            ) {
                await client.query('ROLLBACK');

                return {
                    status: 'refund_amount_mismatch',
                    refund_amount:
                        refund.amount,
                    payment_amount:
                        payment.amount,
                    order_amount:
                        order.total_amount
                };
            }

            const refundProvider =
                String(
                    refund.provider || ''
                ).toUpperCase();

            const paymentProvider =
                String(
                    payment.provider || ''
                ).toUpperCase();

            /*
             * Refund completion V1 adalah refund manual
             * uang outlet.
             *
             * Gateway refund belum diaktifkan di service ini.
             */
            if (
                refundProvider !== 'OUTLET' ||
                paymentProvider !== 'OUTLET'
            ) {
                await client.query('ROLLBACK');

                return {
                    status:
                        'provider_refund_not_supported',
                    refund_provider:
                        refundProvider || 'UNKNOWN',
                    payment_provider:
                        paymentProvider || 'UNKNOWN'
                };
            }

            /*
             * Finalisasi refund.
             */
            const completedRefundResult =
                await client.query(
                    `
                    UPDATE tbl_order_refunds
                    SET
                        status = 'COMPLETED',
                        completed_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP,
                        last_error = NULL
                    WHERE id = $1
                    RETURNING *
                    `,
                    [refund.id]
                );

            /*
             * Lifecycle order selesai sebagai REFUNDED.
             *
             * Tidak mengubah tbl_payments.payment_status.
             */
            const refundedOrderResult =
                await client.query(
                    `
                    UPDATE tbl_orders_v2
                    SET status = 'REFUNDED'
                    WHERE id = $1
                    RETURNING
                        id,
                        status,
                        payment_mode,
                        total_amount
                    `,
                    [order.id]
                );


            /*
             * Inventory Refund Reversal V1.
             *
             * SALE movement tetap disimpan sebagai histori bahwa
             * inventory pernah keluar.
             *
             * Refund membuat REFUND_RETURN append-only dan
             * mengembalikan quantity_on_hand ke warehouse SALE asli.
             *
             * Unique index:
             * (reference_doc, product_id, movement_type)
             * WHERE movement_type = 'REFUND_RETURN'
             *
             * menjamin satu reversal per product/order.
             */
            const inventoryReferenceDoc =
                `ORD-${order.id}`;

            const saleMovementsResult =
                await client.query(
                    `
                    SELECT
                        id,
                        product_id,
                        warehouse_id,
                        quantity,
                        reference_doc,
                        created_at
                    FROM tbl_inventory_movements
                    WHERE movement_type = 'SALE'
                      AND reference_doc = $1
                    ORDER BY product_id, id
                    FOR UPDATE
                    `,
                    [inventoryReferenceDoc]
                );

            const inventoryReversal = {
                status:
                    saleMovementsResult.rowCount
                        ? 'processed'
                        : 'nothing_to_return',
                reference_doc:
                    inventoryReferenceDoc,
                movements: []
            };

            for (
                const saleMovement
                of saleMovementsResult.rows
            ) {
                const quantity =
                    Number(saleMovement.quantity);

                if (
                    !Number.isInteger(quantity) ||
                    quantity <= 0
                ) {
                    throw new Error(
                        `INVALID_SALE_MOVEMENT_QUANTITY:${saleMovement.id}`
                    );
                }

                if (
                    !saleMovement.product_id ||
                    !saleMovement.warehouse_id
                ) {
                    throw new Error(
                        `INVALID_SALE_MOVEMENT_LOCATION:${saleMovement.id}`
                    );
                }

                /*
                 * Insert reversal ledger lebih dahulu.
                 *
                 * Jika unique conflict berarti movement ini sudah
                 * pernah direversal, sehingga inventory TIDAK boleh
                 * ditambah lagi.
                 */
                const returnMovementResult =
                    await client.query(
                        `
                        INSERT INTO tbl_inventory_movements
                        (
                            product_id,
                            warehouse_id,
                            movement_type,
                            quantity,
                            reference_doc,
                            created_by
                        )
                        VALUES
                        (
                            $1,
                            $2,
                            'REFUND_RETURN',
                            $3,
                            $4,
                            $5
                        )
                        ON CONFLICT
                        (
                            reference_doc,
                            product_id,
                            movement_type
                        )
                        WHERE movement_type = 'REFUND_RETURN'
                        DO NOTHING
                        RETURNING
                            id,
                            product_id,
                            warehouse_id,
                            movement_type,
                            quantity,
                            reference_doc,
                            created_by,
                            created_at
                        `,
                        [
                            saleMovement.product_id,
                            saleMovement.warehouse_id,
                            quantity,
                            inventoryReferenceDoc,
                            adminUserId
                        ]
                    );

                if (!returnMovementResult.rowCount) {
                    inventoryReversal.movements.push({
                        status:
                            'already_returned',
                        sale_movement_id:
                            saleMovement.id,
                        product_id:
                            saleMovement.product_id,
                        warehouse_id:
                            saleMovement.warehouse_id,
                        quantity
                    });

                    continue;
                }

                const inventoryUpdateResult =
                    await client.query(
                        `
                        UPDATE tbl_inventory
                        SET
                            quantity_on_hand =
                                COALESCE(
                                    quantity_on_hand,
                                    0
                                ) + $3,
                            updated_at =
                                CURRENT_TIMESTAMP
                        WHERE product_id = $1
                          AND warehouse_id = $2
                        RETURNING
                            id,
                            product_id,
                            warehouse_id,
                            quantity_on_hand,
                            updated_at
                        `,
                        [
                            saleMovement.product_id,
                            saleMovement.warehouse_id,
                            quantity
                        ]
                    );

                if (!inventoryUpdateResult.rowCount) {
                    throw new Error(
                        `REFUND_INVENTORY_NOT_FOUND:${saleMovement.product_id}:${saleMovement.warehouse_id}`
                    );
                }

                inventoryReversal.movements.push({
                    status: 'returned',
                    sale_movement_id:
                        saleMovement.id,
                    quantity,
                    movement:
                        returnMovementResult.rows[0],
                    inventory:
                        inventoryUpdateResult.rows[0]
                });
            }


            /*
             * Loyalty Refund Reversal V1.
             *
             * Reward ORDER_PAID tetap disimpan.
             * Refund menambahkan ledger reversal append-only.
             */
            let loyaltyReversal = {
                status: 'not_applicable'
            };

            if (order.customer_id) {
                const rewardKey =
                    `ORDER_PAID:${order.id}`;

                const reversalKey =
                    `ORDER_REFUND_REVERSAL:${order.id}`;

                const originalRewardResult =
                    await client.query(
                        `
                        SELECT
                            id,
                            customer_id,
                            points,
                            transaction_type,
                            description
                        FROM tbl_loyalty_points
                        WHERE customer_id = $1
                          AND transaction_type = 'ORDER_PAID'
                          AND description = $2
                        FOR UPDATE
                        `,
                        [
                            order.customer_id,
                            rewardKey
                        ]
                    );

                if (originalRewardResult.rowCount) {
                    const originalReward =
                        originalRewardResult.rows[0];

                    const aggregateResult =
                        await client.query(
                            `
                            SELECT
                                id,
                                customer_id,
                                total_points,
                                total_spent,
                                member_tier
                            FROM tbl_customer_loyalty_v2
                            WHERE customer_id = $1
                            FOR UPDATE
                            `,
                            [order.customer_id]
                        );

                    if (!aggregateResult.rowCount) {
                        throw new Error(
                            `LOYALTY_AGGREGATE_MISSING:${order.customer_id}`
                        );
                    }

                    const originalPoints =
                        Number(originalReward.points) || 0;

                    const reversalPoints =
                        -originalPoints;

                    const reversalResult =
                        await client.query(
                            `
                            INSERT INTO tbl_loyalty_points
                            (
                                customer_id,
                                points,
                                transaction_type,
                                description
                            )
                            VALUES
                            (
                                $1,
                                $2,
                                'ORDER_REFUND_REVERSAL',
                                $3
                            )
                            ON CONFLICT
                            (
                                customer_id,
                                transaction_type,
                                description
                            )
                            DO NOTHING
                            RETURNING
                                id,
                                customer_id,
                                points,
                                transaction_type,
                                description,
                                created_at
                            `,
                            [
                                order.customer_id,
                                reversalPoints,
                                reversalKey
                            ]
                        );

                    if (reversalResult.rowCount) {
                        const aggregateUpdateResult =
                            await client.query(
                                `
                                UPDATE tbl_customer_loyalty_v2
                                SET
                                    total_points =
                                        GREATEST(
                                            total_points - $2::integer,
                                            0
                                        ),
                                    total_spent =
                                        GREATEST(
                                            total_spent - $3::numeric,
                                            0
                                        ),
                                    member_tier =
                                        CASE
                                            WHEN GREATEST(
                                                total_spent - $3::numeric,
                                                0
                                            ) >= 5000000
                                                THEN 'Platinum'
                                            WHEN GREATEST(
                                                total_spent - $3::numeric,
                                                0
                                            ) >= 2000000
                                                THEN 'Gold'
                                            ELSE 'Silver'
                                        END,
                                    updated_at =
                                        CURRENT_TIMESTAMP
                                WHERE customer_id = $1
                                RETURNING
                                    customer_id,
                                    total_points,
                                    total_spent,
                                    member_tier,
                                    updated_at
                                `,
                                [
                                    order.customer_id,
                                    originalPoints,
                                    refund.amount
                                ]
                            );

                        loyaltyReversal = {
                            status: 'reversed',
                            original_points:
                                originalPoints,
                            reversed_points:
                                reversalPoints,
                            ledger:
                                reversalResult.rows[0],
                            aggregate:
                                aggregateUpdateResult.rows[0]
                        };
                    } else {
                        loyaltyReversal = {
                            status: 'already_reversed',
                            original_points:
                                originalPoints
                        };
                    }
                } else {
                    loyaltyReversal = {
                        status:
                            'original_reward_not_found'
                    };
                }
            }

            /*
             * Refund Notification V1.
             *
             * In-app notification disimpan di transaksi yang sama
             * dengan refund completion.
             * event_key membuat replay tetap idempotent.
             */
            let refundNotification = {
                status: 'customer_not_linked'
            };

            if (order.customer_id) {
                const customerResult =
                    await client.query(
                        `
                        SELECT
                            id,
                            user_id,
                            full_name
                        FROM tbl_customers
                        WHERE id = $1
                        `,
                        [order.customer_id]
                    );

                if (customerResult.rowCount) {
                    const customer =
                        customerResult.rows[0];

                    if (customer.user_id) {
                        const notificationKey =
                            `ORDER_REFUNDED:${order.id}`;

                        const notificationResult =
                            await client.query(
                                `
                                INSERT INTO tbl_notifications
                                (
                                    user_id,
                                    title,
                                    message,
                                    event_key
                                )
                                VALUES
                                (
                                    $1,
                                    $2,
                                    $3,
                                    $4
                                )
                                ON CONFLICT (event_key)
                                WHERE event_key IS NOT NULL
                                DO NOTHING
                                RETURNING
                                    id,
                                    user_id,
                                    title,
                                    message,
                                    event_key,
                                    created_at
                                `,
                                [
                                    customer.user_id,
                                    'Refund Pesanan Selesai',
                                    `Refund pesanan ${order.id} sebesar Rp${refund.amount} sudah selesai diproses.`,
                                    notificationKey
                                ]
                            );

                        if (notificationResult.rowCount) {
                            refundNotification = {
                                status: 'created',
                                notification:
                                    notificationResult.rows[0]
                            };
                        } else {
                            refundNotification = {
                                status: 'already_created',
                                event_key:
                                    notificationKey
                            };
                        }
                    }
                }
            }

            const financeRefundReference =
                `REFUND-${refund.id}`;

            const financeRevenueResult =
                await client.query(
                    `
                    INSERT INTO tbl_general_ledger
                    (
                        transaction_reference,
                        account_code,
                        account_name,
                        debit,
                        credit,
                        description
                    )
                    VALUES
                    (
                        $1,
                        '4000',
                        'Pendapatan Penjualan',
                        $2,
                        0,
                        $3
                    )
                    ON CONFLICT
                    (
                        transaction_reference,
                        account_code
                    )
                    DO NOTHING
                    RETURNING *
                    `,
                    [
                        financeRefundReference,
                        refund.amount,
                        `Pembalikan pendapatan refund pesanan ORD-${order.id}`
                    ]
                );

            const financeCashResult =
                await client.query(
                    `
                    INSERT INTO tbl_general_ledger
                    (
                        transaction_reference,
                        account_code,
                        account_name,
                        debit,
                        credit,
                        description
                    )
                    VALUES
                    (
                        $1,
                        '1100',
                        'Kas & Bank',
                        0,
                        $2,
                        $3
                    )
                    ON CONFLICT
                    (
                        transaction_reference,
                        account_code
                    )
                    DO NOTHING
                    RETURNING *
                    `,
                    [
                        financeRefundReference,
                        refund.amount,
                        `Kas keluar refund pesanan ORD-${order.id}`
                    ]
                );

            await client.query('COMMIT');

            return {
                status: 'success',
                refund:
                    completedRefundResult.rows[0],
                order:
                    refundedOrderResult.rows[0],
                payment: {
                    id:
                        payment.id,
                    payment_status:
                        payment.payment_status,
                    provider:
                        payment.provider,
                    amount:
                        payment.amount
                },
                completed_by:
                    adminUserId,
                inventory_reversal:
                    inventoryReversal,
                loyalty_reversal:
                    loyaltyReversal,
                refund_notification:
                    refundNotification,
                  finance_refund_reversal: {
                    transaction_reference: financeRefundReference,
                    revenue: financeRevenueResult.rows[0] || null,
                    cash: financeCashResult.rows[0] || null
                  }
            };
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}

            throw err;
        } finally {
            client.release();
        }
    }
}

module.exports = OrderRefundCompletionService;
