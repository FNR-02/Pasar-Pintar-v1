class MerchantEntitlementService {
    constructor(db) {
        this.db = db;
    }

    async recordFromOrderPaid(orderId) {
        if (!orderId) {
            throw new Error('order_id wajib');
        }

        const sourceResult = await this.db.query(
            `
            SELECT
                o.id,
                o.merchant_id,
                o.market_order_id,
                o.total_amount,
                p.id AS payment_id,
                p.provider,
                p.payment_method,
                p.payment_status,
                p.amount AS payment_amount
            FROM tbl_orders_v2 o
            LEFT JOIN tbl_payments p
              ON p.order_id = o.id
             AND p.payment_status = 'PAID'
            WHERE o.id = $1
            `,
            [orderId]
        );

        if (!sourceResult.rowCount) {
            return {
                status: 'order_not_found',
                entitlement: null
            };
        }

        const source = sourceResult.rows[0];

        if (
            !source.market_order_id ||
            !source.merchant_id
        ) {
            return {
                status: 'not_marketplace_order',
                entitlement: null
            };
        }

        const paidPayments =
            sourceResult.rows.filter(
                row => Boolean(row.payment_id)
            );

        if (paidPayments.length !== 1) {
            throw new Error(
                'Marketplace ORDER_PAID wajib memiliki tepat 1 payment PAID'
            );
        }

        const paidSource =
            paidPayments[0];

        const orderAmount =
            Number(source.total_amount);
        const paymentAmount =
            Number(paidSource.payment_amount);

        if (
            !Number.isFinite(orderAmount) ||
            !Number.isFinite(paymentAmount) ||
            orderAmount < 0 ||
            paymentAmount !== orderAmount
        ) {
            throw new Error(
                'Nominal payment marketplace tidak sesuai order'
            );
        }

        const provider =
            String(paidSource.provider || '')
                .toUpperCase();

        const paymentMethod =
            String(paidSource.payment_method || '')
                .toUpperCase();

        let entitlementStatus;

        if (
            provider === 'OUTLET' &&
            paymentMethod === 'PAY_AT_OUTLET'
        ) {
            /*
             * Uang diterima langsung oleh merchant.
             * Record entitlement tetap dibuat sebagai
             * jejak gross sale, tetapi tidak menjadi
             * kewajiban payout Pasar Pintar.
             */
            entitlementStatus = 'SETTLED';
        } else if (
            provider === 'MIDTRANS' &&
            [
                'QRIS',
                'VIRTUAL_ACCOUNT'
            ].includes(paymentMethod)
        ) {
            /*
             * Dana marketplace berada dalam custody
             * payment gateway / Pasar Pintar.
             */
            entitlementStatus = 'PENDING';
        } else {
            throw new Error(
                `Payment marketplace tidak didukung untuk entitlement: ` +
                `${provider}/${paymentMethod}`
            );
        }

        const result = await this.db.query(
            `
            INSERT INTO tbl_merchant_entitlements (
                merchant_id,
                order_id,
                market_order_id,
                gross_amount,
                platform_commission,
                merchant_entitlement,
                status,
                source_event
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                0,
                $4,
                $5,
                'ORDER_PAID'
            )
            ON CONFLICT (order_id)
            DO NOTHING
            RETURNING *
            `,
            [
                source.merchant_id,
                source.id,
                source.market_order_id,
                source.total_amount,
                entitlementStatus
            ]
        );

        if (result.rowCount === 1) {
            return {
                status: 'created',
                entitlement: result.rows[0]
            };
        }

        const existing = await this.db.query(
            `
            SELECT *
            FROM tbl_merchant_entitlements
            WHERE order_id = $1
            `,
            [orderId]
        );

        if (existing.rowCount === 1) {
            const existingEntitlement =
                existing.rows[0];

            if (
                existingEntitlement.status !==
                    entitlementStatus
            ) {
                throw new Error(
                    `Status entitlement existing tidak sesuai custody: ` +
                    `${existingEntitlement.status} != ${entitlementStatus}`
                );
            }

            if (
                Number(
                    existingEntitlement.gross_amount
                ) !== orderAmount ||
                Number(
                    existingEntitlement
                        .merchant_entitlement
                ) !== orderAmount ||
                Number(
                    existingEntitlement
                        .platform_commission
                ) !== 0
            ) {
                throw new Error(
                    'Nominal entitlement existing tidak sesuai order'
                );
            }

            return {
                status: 'already_exists',
                entitlement: existingEntitlement
            };
        }

        throw new Error(
            'Entitlement gagal dibuat tanpa record existing'
        );
    }
}

module.exports = MerchantEntitlementService;
