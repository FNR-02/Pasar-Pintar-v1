class ProductInquiryHandler {
    constructor(pool) {
        this.pool = pool;
    }

    extractSearchTerm(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/\b(berapa|harga|stok|ada|tersedia|produk|barang|dong|ya|berapa harga)\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    async handle({ text }) {
        const searchTerm =
            this.extractSearchTerm(text);

        if (!searchTerm) {
            return {
                status: 'need_product_name',
                products: [],
                responseText:
                    'Produk apa yang ingin Anda cek?'
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
            [`%${searchTerm}%`]
        );

        if (result.rowCount === 0) {
            return {
                status: 'not_found',
                searchTerm,
                products: [],
                responseText:
                    `Maaf, produk "${searchTerm}" belum ditemukan.`
            };
        }

        const products = result.rows.map(row => ({
            id: row.id,
            sku: row.sku,
            name: row.name,
            price: Number(row.price),
            stock: Number(row.stock)
        }));

        const rupiah = value =>
            new Intl.NumberFormat(
                'id-ID',
                {
                    style: 'currency',
                    currency: 'IDR',
                    maximumFractionDigits: 0
                }
            ).format(value);

        const lines = products.map(
            (product, index) =>
                `${index + 1}. ${product.name} — ` +
                `${rupiah(product.price)} — ` +
                `stok ${product.stock}`
        );

        return {
            status: 'found',
            searchTerm,
            products,
            responseText:
                `Saya menemukan ${products.length} produk:\n\n` +
                lines.join('\n')
        };
    }
}

module.exports = ProductInquiryHandler;
