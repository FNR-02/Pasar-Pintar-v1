class OrderStatusHandler {
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

        const orderResult = await this.pool.query(
            `
            SELECT
                o.id,
                o.status,
                o.total_amount,
                o.created_at,

                (
                    SELECT json_agg(
                        json_build_object(
                            'name', p.name,
                            'quantity', oi.quantity,
                            'unit_price', oi.unit_price
                        )
                        ORDER BY p.name
                    )
                    FROM tbl_order_items oi
                    LEFT JOIN tbl_products p
                        ON p.id = oi.product_id
                    WHERE oi.order_id = o.id
                ) AS items,

                (
                    SELECT s.shipping_status
                    FROM tbl_shipments s
                    WHERE s.order_id = o.id
                    ORDER BY s.updated_at DESC NULLS LAST
                    LIMIT 1
                ) AS shipping_status,

                (
                    SELECT s.tracking_number
                    FROM tbl_shipments s
                    WHERE s.order_id = o.id
                    ORDER BY s.updated_at DESC NULLS LAST
                    LIMIT 1
                ) AS tracking_number,

                (
                    SELECT pay.payment_status
                    FROM tbl_payments pay
                    WHERE pay.order_id = o.id
                    ORDER BY pay.created_at DESC
                    LIMIT 1
                ) AS payment_status

            FROM tbl_orders_v2 o
            WHERE o.customer_id = $1
            ORDER BY o.created_at DESC
            LIMIT 1
            `,
            [customerId]
        );

        if (orderResult.rowCount === 0) {
            return {
                status: 'not_found',
                order: null,
                responseText:
                    'Belum ada pesanan yang ditemukan pada akun Anda.'
            };
        }

        const row = orderResult.rows[0];

        const items =
            Array.isArray(row.items)
                ? row.items
                : [];

        const rupiah = value =>
            new Intl.NumberFormat(
                'id-ID',
                {
                    style: 'currency',
                    currency: 'IDR',
                    maximumFractionDigits: 0
                }
            ).format(Number(value || 0));

        const itemLines =
            items.length > 0
                ? items.map(
                    item =>
                        `- ${item.name || 'Produk'} x${item.quantity}`
                ).join('\n')
                : '- Detail produk tidak tersedia';

        const responseLines = [
            'Pesanan terakhir Anda:',
            '',
            `Order: ${row.id}`,
            `Status: ${row.status}`,
            `Pembayaran: ${row.payment_status || 'Belum tersedia'}`,
            `Pengiriman: ${row.shipping_status || 'Belum tersedia'}`,
            `Total: ${rupiah(row.total_amount)}`,
            '',
            'Produk:',
            itemLines
        ];

        if (row.tracking_number) {
            responseLines.push(
                '',
                `Nomor tracking: ${row.tracking_number}`
            );
        }

        return {
            status: 'found',
            order: {
                id: row.id,
                status: row.status,
                paymentStatus:
                    row.payment_status || null,
                shippingStatus:
                    row.shipping_status || null,
                trackingNumber:
                    row.tracking_number || null,
                totalAmount:
                    Number(row.total_amount),
                items
            },
            responseText:
                responseLines.join('\n')
        };
    }
}

module.exports = OrderStatusHandler;
