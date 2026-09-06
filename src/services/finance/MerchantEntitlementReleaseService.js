class MerchantEntitlementReleaseService {
    constructor(db) {
        this.db = db;
    }

    async getClient() {
        const isExternalClient =
            typeof this.db.release === 'function';

        const ownsClient =
            !isExternalClient &&
            typeof this.db.connect === 'function';

        const client =
            ownsClient
                ? await this.db.connect()
                : this.db;

        return {
            client,
            ownsClient
        };
    }

    async releaseByOrderId(orderId) {
        if (!orderId) {
            return {
                status: 'invalid_input'
            };
        }

        const {
            client,
            ownsClient
        } = await this.getClient();

        try {
            if (ownsClient) {
                await client.query('BEGIN');
            }

            const entitlementResult =
                await client.query(
                    `
                    SELECT
                        e.id,
                        e.order_id,
                        e.market_order_id,
                        e.status,
                        o.status AS order_status,
                        o.fulfillment_type
                    FROM tbl_merchant_entitlements e
                    INNER JOIN tbl_orders_v2 o
                        ON o.id = e.order_id
                    WHERE e.order_id = $1
                    FOR UPDATE OF e, o
                    `,
                    [orderId]
                );

            if (!entitlementResult.rowCount) {
                if (ownsClient) {
                    await client.query('ROLLBACK');
                }

                return {
                    status:
                        'entitlement_not_found'
                };
            }

            const entitlement =
                entitlementResult.rows[0];

            if (
                entitlement.status ===
                'AVAILABLE'
            ) {
                if (ownsClient) {
                    await client.query('COMMIT');
                }

                return {
                    status:
                        'already_available',
                    released_count: 0
                };
            }

            if (
                entitlement.status ===
                'SETTLED'
            ) {
                if (ownsClient) {
                    await client.query('COMMIT');
                }

                return {
                    status:
                        'already_settled',
                    released_count: 0
                };
            }

            if (
                entitlement.status !==
                'PENDING'
            ) {
                if (ownsClient) {
                    await client.query('ROLLBACK');
                }

                return {
                    status:
                        'entitlement_not_releasable',
                    current_status:
                        entitlement.status
                };
            }

            if (
                entitlement.order_status !==
                'DELIVERED'
            ) {
                if (ownsClient) {
                    await client.query('ROLLBACK');
                }

                return {
                    status:
                        'order_not_delivered',
                    current_status:
                        entitlement.order_status,
                    fulfillment_type:
                        entitlement.fulfillment_type
                };
            }

            if (!entitlement.market_order_id) {
                if (ownsClient) {
                    await client.query('ROLLBACK');
                }

                return {
                    status:
                        'market_order_not_found'
                };
            }

            const paymentResult =
                await client.query(
                    `
                    SELECT
                        mp.id,
                        mp.payment_status,
                        mp.provider,
                        mp.payment_method,
                        gs.id AS settlement_id,
                        gs.status AS settlement_status
                    FROM tbl_market_payments mp
                    LEFT JOIN
                        tbl_gateway_settlement_allocations gsa
                      ON gsa.market_payment_id = mp.id
                    LEFT JOIN
                        tbl_gateway_settlements gs
                      ON gs.id = gsa.settlement_id
                    WHERE mp.market_order_id = $1
                      AND mp.payment_status = 'PAID'
                    ORDER BY mp.created_at DESC, mp.id
                    FOR UPDATE OF mp
                    `,
                    [
                        entitlement
                            .market_order_id
                    ]
                );

            if (paymentResult.rowCount !== 1) {
                if (ownsClient) {
                    await client.query('ROLLBACK');
                }

                return {
                    status:
                        'paid_payment_not_unique',
                    payment_count:
                        paymentResult.rowCount
                };
            }

            const payment =
                paymentResult.rows[0];

            const provider =
                String(
                    payment.provider || ''
                )
                    .trim()
                    .toUpperCase();

            const paymentMethod =
                String(
                    payment.payment_method || ''
                )
                    .trim()
                    .toUpperCase();

            if (
                provider === 'OUTLET' &&
                paymentMethod ===
                    'PAY_AT_OUTLET'
            ) {
                if (ownsClient) {
                    await client.query('COMMIT');
                }

                return {
                    status:
                        'direct_to_merchant_no_release',
                    released_count: 0
                };
            }

            if (
                provider !== 'MIDTRANS' ||
                ![
                    'QRIS',
                    'VIRTUAL_ACCOUNT'
                ].includes(paymentMethod)
            ) {
                if (ownsClient) {
                    await client.query('ROLLBACK');
                }

                return {
                    status:
                        'unsupported_payment',
                    provider,
                    payment_method:
                        paymentMethod
                };
            }

            if (
                payment.settlement_status !==
                'RECONCILED'
            ) {
                if (ownsClient) {
                    await client.query('ROLLBACK');
                }

                return {
                    status:
                        'settlement_not_reconciled',
                    settlement_id:
                        payment.settlement_id || null,
                    settlement_status:
                        payment.settlement_status ||
                        null
                };
            }

            const updated =
                await client.query(
                    `
                    UPDATE tbl_merchant_entitlements
                    SET
                        status = 'AVAILABLE',
                        available_at =
                            CURRENT_TIMESTAMP
                    WHERE id = $1
                      AND status = 'PENDING'
                    RETURNING id
                    `,
                    [entitlement.id]
                );

            if (updated.rowCount !== 1) {
                throw new Error(
                    'Merchant entitlement berubah secara bersamaan'
                );
            }

            if (ownsClient) {
                await client.query('COMMIT');
            }

            return {
                status: 'released',
                released_count: 1,
                entitlement_id:
                    entitlement.id,
                order_id:
                    entitlement.order_id,
                market_order_id:
                    entitlement.market_order_id
            };
        } catch (err) {
            if (ownsClient) {
                try {
                    await client.query(
                        'ROLLBACK'
                    );
                } catch (_) {}
            }

            throw err;
        } finally {
            if (
                ownsClient &&
                typeof client.release ===
                    'function'
            ) {
                client.release();
            }
        }
    }

    async releaseByMarketOrderId(
        marketOrderId
    ) {
        if (!marketOrderId) {
            return {
                status: 'invalid_input',
                released_count: 0,
                results: []
            };
        }

        const orderResult =
            await this.db.query(
                `
                SELECT order_id
                FROM tbl_merchant_entitlements
                WHERE market_order_id = $1
                ORDER BY order_id
                `,
                [marketOrderId]
            );

        if (!orderResult.rowCount) {
            return {
                status:
                    'entitlement_not_found',
                released_count: 0,
                results: []
            };
        }

        const results = [];

        for (
            const row
            of orderResult.rows
        ) {
            const result =
                await this.releaseByOrderId(
                    row.order_id
                );

            results.push({
                order_id:
                    row.order_id,
                ...result
            });
        }

        const releasedCount =
            results.reduce(
                (total, result) =>
                    total +
                    Number(
                        result.released_count ||
                        0
                    ),
                0
            );

        return {
            status:
                releasedCount > 0
                    ? 'released'
                    : 'no_release',
            released_count:
                releasedCount,
            results
        };
    }
}

module.exports =
    MerchantEntitlementReleaseService;
