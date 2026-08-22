class OrderConfirmationHandler {
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

        const draftResult =
            await this.pool.query(
                `
                SELECT
                    d.id,
                    d.customer_id,
                    d.product_id,
                    d.quantity,
                    d.unit_price,
                    d.subtotal,
                    d.available_stock_snapshot,
                    d.source_message_id,
                    d.status,
                    d.created_at,
                    d.expires_at,
                    p.name AS product_name,
                    p.sku,
                    p.status AS product_status
                FROM tbl_whatsapp_order_drafts d
                JOIN tbl_products p
                    ON p.id = d.product_id
                WHERE d.customer_id = $1
                  AND d.status = 'PENDING_CONFIRMATION'
                ORDER BY d.created_at DESC
                LIMIT 1
                `,
                [customerId]
            );

        if (draftResult.rowCount === 0) {
            return {
                status: 'draft_not_found',
                draft: null,
                responseText:
                    'Tidak ada draft pesanan yang menunggu konfirmasi.'
            };
        }

        const draft =
            draftResult.rows[0];

        if (
            new Date(draft.expires_at).getTime() <=
            Date.now()
        ) {
            return {
                status: 'draft_expired',
                draft: null,
                responseText:
                    'Draft pesanan sudah kedaluwarsa. Silakan buat pesanan baru.'
            };
        }

        if (draft.product_status !== 'ACTIVE') {
            return {
                status: 'product_inactive',
                draft: null,
                responseText:
                    'Produk pada draft sudah tidak aktif.'
            };
        }

        const stockResult =
            await this.pool.query(
                `
                SELECT
                    COALESCE(
                        SUM(quantity_on_hand),
                        0
                    )::int AS stock
                FROM tbl_inventory
                WHERE product_id = $1
                `,
                [draft.product_id]
            );

        const currentStock =
            Number(
                stockResult.rows[0]?.stock || 0
            );

        if (currentStock < draft.quantity) {
            return {
                status: 'insufficient_stock',
                draft: null,
                responseText:
                    `Stok ${draft.product_name} saat ini hanya ${currentStock}.`
            };
        }

        const priceResult =
            await this.pool.query(
                `
                SELECT amount
                FROM tbl_product_prices
                WHERE product_id = $1
                  AND price_type = 'RETAIL'
                ORDER BY effective_date DESC
                LIMIT 1
                `,
                [draft.product_id]
            );

        if (priceResult.rowCount === 0) {
            return {
                status: 'price_unavailable',
                draft: null,
                responseText:
                    'Harga terbaru produk tidak tersedia.'
            };
        }

        const currentPrice =
            Number(priceResult.rows[0].amount);

        const snapshotPrice =
            Number(draft.unit_price);

        if (currentPrice !== snapshotPrice) {
            return {
                status: 'price_changed',
                draft: null,
                responseText:
                    'Harga produk telah berubah. Silakan buat draft pesanan baru.'
            };
        }

        const expectedSubtotal =
            currentPrice *
            Number(draft.quantity);

        if (
            expectedSubtotal !==
            Number(draft.subtotal)
        ) {
            return {
                status: 'subtotal_mismatch',
                draft: null,
                responseText:
                    'Nilai draft tidak lagi valid. Silakan buat draft baru.'
            };
        }

        return {
            status: 'confirmation_ready',
            draft: {
                id: draft.id,
                customerId:
                    draft.customer_id,
                productId:
                    draft.product_id,
                productName:
                    draft.product_name,
                sku:
                    draft.sku,
                quantity:
                    Number(draft.quantity),
                unitPrice:
                    currentPrice,
                subtotal:
                    expectedSubtotal,
                currentStock,
                expiresAt:
                    draft.expires_at
            },
            responseText:
                'Draft pesanan valid dan siap dikonfirmasi.'
        };
    }
}

module.exports = OrderConfirmationHandler;
