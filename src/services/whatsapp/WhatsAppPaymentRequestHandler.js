const PaymentIntentService =
    require('../payments/PaymentIntentService');

class WhatsAppPaymentRequestHandler {
    constructor(pool) {
        this.pool = pool;
        this.paymentIntentService =
            new PaymentIntentService(pool);
    }

    async handle({ customer }) {
        const customerId =
            customer?.customer_id || null;

        if (!customerId) {
            return {
                status: 'customer_missing',
                responseText:
                    'Data akun kakak belum ketemu.'
            };
        }

        /*
         * Ambil order PENDING terbaru milik Customer.
         * Handler tidak menerima orderId dari pesan WhatsApp
         * sehingga kepemilikan berasal dari customer identity.
         */
        const orderResult =
            await this.pool.query(
                `
                SELECT
                    id,
                    total_amount,
                    status,
                    created_at
                FROM tbl_orders_v2
                WHERE customer_id = $1
                  AND status = 'PENDING'
                ORDER BY created_at DESC
                LIMIT 1
                `,
                [customerId]
            );

        if (orderResult.rowCount === 0) {
            return {
                status: 'order_not_found',
                responseText:
                    'Saat ini belum ada pesanan yang perlu dibayar kak.'
            };
        }

        const order =
            orderResult.rows[0];

        /*
         * Gunakan canonical payment service.
         * Service menangani ownership, idempotency,
         * existing intent dan gateway creation.
         */
        const result =
            await this.paymentIntentService.create({
                orderId:
                    order.id,
                customerId,
                provider:
                    'MIDTRANS',
                paymentMethod:
                    'QRIS'
            });

        if (
            result.status === 'expired'
        ) {
            return {
                status: 'payment_expired',
                orderId:
                    order.id,
                responseText:
                    'QRIS untuk pesanan ini sudah kedaluwarsa kak. ' +
                    'Silakan minta pembayaran baru ya.'
            };
        }

        if (
            ![
                'created',
                'existing',
                'updated'
            ].includes(result.status) ||
            !result.payment
        ) {
            return {
                status:
                    result.status ||
                    'payment_unavailable',
                responseText:
                    'Maaf kak, pembayaran belum bisa dibuat saat ini.'
            };
        }

        const payment =
            result.payment;

        /*
         * Jangan pernah mengembalikan gateway_response
         * mentah ke WhatsApp.
         */
        const gateway =
            payment.gateway_response || {};

        const qrCodeUrl =
            gateway.qr_code_url || null;

        const amount =
            Number(payment.amount || 0);

        const expiresAt =
            payment.expires_at || null;

        const lines = [
            'Pembayaran QRIS Pasar Pintar',
            '',
            `Nomor pesanan: ${order.id}`,
            `Total: Rp ${amount.toLocaleString('id-ID')}`,
            `Status: ${payment.payment_status}`
        ];

        if (expiresAt) {
            lines.push(
                `Berlaku sampai: ${
                    new Date(expiresAt)
                        .toLocaleString(
                            'id-ID',
                            {
                                timeZone:
                                    'Asia/Jakarta'
                            }
                        )
                }`
            );
        }

        if (qrCodeUrl) {
            lines.push(
                '',
                'QRIS:',
                qrCodeUrl
            );
        }

        return {
            status: 'payment_ready',
            orderId:
                order.id,
            paymentId:
                payment.id,
            paymentStatus:
                payment.payment_status,
            amount,
            expiresAt,
            qrCodeUrl,
            responseText:
                lines.join('\n')
        };
    }
}

module.exports =
    WhatsAppPaymentRequestHandler;
