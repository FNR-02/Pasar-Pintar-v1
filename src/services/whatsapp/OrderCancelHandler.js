class OrderCancelHandler {
    constructor(pool) {
        this.pool = pool;
    }

    async handle({ customer }) {
        const customerId =
            customer?.customer_id || null;

        if (!customerId) {
            return {
                status: 'customer_missing',
                responseText:
                    'Data Customer tidak tersedia.'
            };
        }

        const result =
            await this.pool.query(
                `
                UPDATE tbl_whatsapp_order_drafts
                SET
                    status = 'CANCELLED',
                    cancelled_at = CURRENT_TIMESTAMP
                WHERE customer_id = $1
                  AND status = 'PENDING_CONFIRMATION'
                RETURNING
                    id,
                    customer_id,
                    product_id,
                    quantity,
                    subtotal,
                    status,
                    cancelled_at
                `,
                [customerId]
            );

        if (result.rowCount === 0) {
            return {
                status: 'draft_not_found',
                responseText:
                    'Tidak ada draft pesanan aktif yang bisa dibatalkan.'
            };
        }

        return {
            status: 'cancelled',
            draft: result.rows[0],
            responseText:
                'Draft pesanan berhasil dibatalkan.'
        };
    }
}

module.exports = OrderCancelHandler;
