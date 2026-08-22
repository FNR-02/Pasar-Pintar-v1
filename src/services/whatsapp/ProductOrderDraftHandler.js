class ProductOrderDraftHandler {
    constructor(pool) {
        this.pool = pool;
    }

    parseOrderRequest(text) {
        const value =
            String(text || '')
                .trim()
                .toLowerCase();

        const quantityMatch =
            value.match(/\b(\d{1,3})\b/);

        const quantity =
            quantityMatch
                ? Number(quantityMatch[1])
                : 1;

        const productTerm =
            value
                .replace(/\b(saya|aku|mau|ingin|beli|pesan|order|tolong|dong|ya)\b/g, ' ')
                .replace(/\b\d{1,3}\b/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

        return {
            productTerm,
            quantity
        };
    }

    async handle({ text }) {
        const parsed =
            this.parseOrderRequest(text);

        if (!parsed.productTerm) {
            return {
                status: 'need_product_name',
                draft: null,
                responseText:
                    'Produk apa yang ingin Anda pesan?'
            };
        }

        if (
            !Number.isInteger(parsed.quantity) ||
            parsed.quantity < 1 ||
            parsed.quantity > 100
        ) {
            return {
                status: 'invalid_quantity',
                draft: null,
                responseText:
                    'Jumlah pesanan harus antara 1 sampai 100.'
            };
        }

        const result = await this.pool.query(
            `
            SELECT
                p.id,
                p.sku,
                p.name,

                COALESCE((
                    SELECT pp.amount
                    FROM tbl_product_prices pp
                    WHERE pp.product_id = p.id
                      AND pp.price_type = 'RETAIL'
                    ORDER BY pp.effective_date DESC
                    LIMIT 1
                ), 0) AS price,

                COALESCE((
                    SELECT SUM(i.quantity_on_hand)
                    FROM tbl_inventory i
                    WHERE i.product_id = p.id
                ), 0)::int AS stock

            FROM tbl_products p
            WHERE p.status = 'ACTIVE'
              AND p.name ILIKE $1
            ORDER BY p.name
            LIMIT 10
            `,
            [`%${parsed.productTerm}%`]
        );

        if (result.rowCount === 0) {
            return {
                status: 'product_not_found',
                draft: null,
                responseText:
                    `Produk "${parsed.productTerm}" belum ditemukan.`
            };
        }

        if (result.rowCount > 1) {
            return {
                status: 'multiple_products',
                draft: null,
                products: result.rows.map(row => ({
                    id: row.id,
                    sku: row.sku,
                    name: row.name,
                    price: Number(row.price),
                    stock: Number(row.stock)
                })),
                responseText:
                    'Saya menemukan beberapa produk yang cocok. Mohon sebutkan produk lebih spesifik.'
            };
        }

        const product = result.rows[0];

        const price =
            Number(product.price);

        const stock =
            Number(product.stock);

        if (stock < parsed.quantity) {
            return {
                status: 'insufficient_stock',
                draft: null,
                responseText:
                    `Stok ${product.name} saat ini hanya ${stock}.`
            };
        }

        const subtotal =
            price * parsed.quantity;

        const rupiah = value =>
            new Intl.NumberFormat(
                'id-ID',
                {
                    style: 'currency',
                    currency: 'IDR',
                    maximumFractionDigits: 0
                }
            ).format(value);

        const draft = {
            productId: product.id,
            sku: product.sku,
            productName: product.name,
            quantity: parsed.quantity,
            unitPrice: price,
            subtotal,
            availableStock: stock
        };

        return {
            status: 'draft_ready',
            draft,
            responseText:
                'Draft pesanan:\n\n' +
                `${product.name}\n` +
                `Jumlah: ${parsed.quantity}\n` +
                `Harga satuan: ${rupiah(price)}\n` +
                `Subtotal: ${rupiah(subtotal)}\n\n` +
                'Belum ada pesanan yang dibuat.'
        };
    }
}

module.exports = ProductOrderDraftHandler;
