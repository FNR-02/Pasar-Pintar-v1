class MarketplaceLedgerService {
    constructor(db) {
        this.db = db;
    }

    async classifyOrderPaid(order) {
        const orderId =
            order.id || order.orderId;

        if (!orderId) {
            throw new Error('order_id wajib');
        }

        const result = await this.db.query(
            `
            SELECT
                o.id,
                o.market_order_id,
                o.merchant_id,
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
            LIMIT 1
            `,
            [orderId]
        );

        if (!result.rowCount) {
            return {
                type: 'ORDER_NOT_FOUND',
                order: null
            };
        }

        const dbOrder = result.rows[0];

        if (
            !dbOrder.market_order_id ||
            !dbOrder.merchant_id
        ) {
            return {
                type: 'NON_MARKETPLACE',
                order: dbOrder
            };
        }

        if (!dbOrder.payment_id) {
            return {
                type: 'MARKETPLACE_PAYMENT_NOT_PAID',
                order: dbOrder
            };
        }

        const provider =
            String(dbOrder.provider || '')
                .toUpperCase();

        const paymentMethod =
            String(dbOrder.payment_method || '')
                .toUpperCase();

        if (
            provider === 'OUTLET' &&
            paymentMethod === 'PAY_AT_OUTLET'
        ) {
            return {
                type: 'MARKETPLACE_DIRECT_TO_MERCHANT',
                order: dbOrder
            };
        }

        if (
            provider === 'MIDTRANS' &&
            [
                'QRIS',
                'VIRTUAL_ACCOUNT'
            ].includes(paymentMethod)
        ) {
            return {
                type: 'MARKETPLACE_PLATFORM_CUSTODY',
                order: dbOrder
            };
        }

        return {
            type: 'MARKETPLACE_PAYMENT_UNSUPPORTED',
            order: dbOrder
        };
    }

    async recordOrderPaid(order) {
        const classification =
            await this.classifyOrderPaid(order);

        if (
            classification.type !==
            'MARKETPLACE_PLATFORM_CUSTODY'
        ) {
            return {
                status: 'skipped',
                type: classification.type
            };
        }

        const dbOrder = classification.order;
        const amount = Number(dbOrder.total_amount);

        if (
            !Number.isFinite(amount) ||
            amount < 0
        ) {
            throw new Error('total_amount tidak valid');
        }

        const ref = `ORD-${dbOrder.id}`;

        await this.db.query(
            `
            INSERT INTO tbl_general_ledger (
                transaction_reference,
                account_code,
                account_name,
                debit,
                credit,
                description
            )
            VALUES (
                $1,
                '1400',
                'Dana di Payment Gateway',
                $2,
                0,
                $3
            )
            ON CONFLICT (
                transaction_reference,
                account_code
            )
            DO NOTHING
            `,
            [
                ref,
                amount,
                `Dana marketplace di gateway ${ref}`
            ]
        );

        await this.db.query(
            `
            INSERT INTO tbl_general_ledger (
                transaction_reference,
                account_code,
                account_name,
                debit,
                credit,
                description
            )
            VALUES (
                $1,
                '2200',
                'Kewajiban kepada Merchant',
                0,
                $2,
                $3
            )
            ON CONFLICT (
                transaction_reference,
                account_code
            )
            DO NOTHING
            `,
            [
                ref,
                amount,
                `Hak Merchant marketplace ${ref}`
            ]
        );

        return {
            status: 'recorded',
            type: classification.type,
            transaction_reference: ref,
            amount
        };
    }
}

module.exports = MarketplaceLedgerService;
