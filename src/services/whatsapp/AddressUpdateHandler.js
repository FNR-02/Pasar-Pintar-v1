class AddressUpdateHandler {
    constructor(pool) {
        this.pool = pool;
    }

    extractAddress(text) {
        const value =
            String(text || '')
                .trim();

        if (!value) {
            return null;
        }

        const cleaned =
            value
                .replace(
                    /^(alamat|kirim ke|antar ke|lokasi)\s*[:\-]?\s*/i,
                    ''
                )
                .trim();

        return cleaned || null;
    }

    async handle({
        text,
        customer
    }) {
        const customerId =
            customer?.customer_id || null;

        if (!customerId) {
            return {
                status: 'customer_missing',
                responseText:
                    'Data customer tidak tersedia.'
            };
        }

        const address =
            this.extractAddress(text);

        if (!address) {
            return {
                status: 'address_missing',
                responseText:
                    'Silakan kirim alamat lengkap.\n\n' +
                    'Contoh: "antar ke Jl. Merdeka No. 10 Bandung"'
            };
        }

        const result =
            await this.pool.query(
                `
                UPDATE tbl_whatsapp_order_drafts
                SET
                    shipping_address = $2
                WHERE id = (
                    SELECT id
                    FROM tbl_whatsapp_order_drafts
                    WHERE customer_id = $1
                      AND status = 'PENDING_CONFIRMATION'
                      AND expires_at > CURRENT_TIMESTAMP
                    ORDER BY created_at DESC
                    LIMIT 1
                )
                RETURNING
                    id,
                    shipping_address
                `,
                [
                    customerId,
                    address
                ]
            );

        if (result.rowCount === 0) {
            return {
                status: 'draft_not_found',
                responseText:
                    'Belum ada draft pesanan aktif.\n\n' +
                    'Silakan buat pesanan terlebih dahulu.'
            };
        }

        return {
            status: 'address_updated',
            shippingAddress:
                result.rows[0].shipping_address,
            responseText:
                'Alamat pengiriman berhasil disimpan:\n\n' +
                result.rows[0].shipping_address +
                '\n\nBalas KONFIRMASI untuk membuat pesanan.'
        };
    }
}

module.exports = AddressUpdateHandler;
