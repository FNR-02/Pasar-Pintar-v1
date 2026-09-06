const ProductInquiryHandler =
    require('./ProductInquiryHandler');

class ProductImageHandler {
    constructor(pool) {
        this.pool = pool;
        this.inquiry =
            new ProductInquiryHandler(pool);
    }

    parseRequest(text) {
        let value =
            String(text || '')
                .trim()
                .toLowerCase();

        value = value.replace(
            /\b(boleh|saya|aku|minta|tolong|lihat|lihatkan|kirim|kirimkan|gambar|gambarnya|foto|fotonya|photo|produk|dong|ya+|nih)\b/g,
            ' '
        );

        value =
            value
                .replace(/\s+/g, ' ')
                .trim();

        return this.inquiry.parseInquiryRequest(value);
    }

    async handle({ text }) {
        const parsed =
            this.parseRequest(text);

        const searchTerm =
            parsed.productTerm;

        if (!searchTerm) {
            return {
                status: 'need_product_name',
                products: [],
                responseText:
                    'Mau lihat foto produk apa?'
            };
        }

        const patterns =
            searchTerm
                .split(/\s+/)
                .filter(Boolean)
                .map(token => `%${token}%`);

        const result =
            await this.pool.query(
                `
                SELECT
                    p.id,
                    p.name,
                    p.image_url,
                    p.selling_unit,
                    p.pack_size_value,
                    p.pack_size_unit,
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
                  AND p.customer_visible = TRUE
                  AND p.name ILIKE ALL($1::text[])
                ORDER BY p.name
                LIMIT 20
                `,
                [patterns]
            );

        let products =
            result.rows;

        if (
            parsed.packSizeValue !== null &&
            parsed.packSizeUnit
        ) {
            products =
                products.filter(row => {
                    const structuredMatch =
                        Number(row.pack_size_value) ===
                            parsed.packSizeValue &&
                        String(
                            row.pack_size_unit || ''
                        ).toUpperCase() ===
                            parsed.packSizeUnit;

                    const unitPattern = {
                        GRAM: '(?:g|gr|gram)',
                        KG: '(?:kg|kilogram)',
                        ML: '(?:ml)',
                        LITER: '(?:l|liter|litre)',
                        PCS: '(?:pcs|pc)'
                    }[parsed.packSizeUnit];

                    const nameMatch =
                        unitPattern &&
                        new RegExp(
                            `\\b${parsed.packSizeValue}\\s*${unitPattern}\\b`,
                            'i'
                        ).test(
                            String(row.name || '')
                        );

                    return structuredMatch || nameMatch;
                });
        }

        if (!products.length) {
            return {
                status: 'not_found',
                products: [],
                responseText:
                    `Produk "${searchTerm}" belum ditemukan.`
            };
        }

        if (products.length > 1) {
            const choices =
                products.map(
                    (product, index) =>
                        `${index + 1}. ${product.name}`
                );

            return {
                status: 'multiple_products',
                products,
                responseText:
                    `Ada beberapa pilihan ${searchTerm}:\n\n` +
                    choices.join('\n') +
                    '\n\nMau lihat yang mana?'
            };
        }

        const product =
            products[0];

        if (!product.image_url) {
            return {
                status: 'image_not_available',
                products,
                responseText:
                    `Foto ${product.name} belum tersedia.`
            };
        }

        const rupiah =
            new Intl.NumberFormat(
                'id-ID',
                {
                    style: 'currency',
                    currency: 'IDR',
                    maximumFractionDigits: 0
                }
            ).format(Number(product.price));

        const relativeUrl =
            String(product.image_url);

        const mediaUrl =
            /^https?:\/\//i.test(relativeUrl)
                ? relativeUrl
                : 'https://api.pasarpintar.cloud' +
                  (
                      relativeUrl.startsWith('/')
                          ? relativeUrl
                          : `/${relativeUrl}`
                  );

        return {
            status: 'found',
            products,
            responseText:
                `${product.name}\n` +
                `Harga: ${rupiah}\n` +
                `Stok: ${Number(product.stock)} ${String(
                    product.selling_unit || 'PCS'
                ).toLowerCase()}`,
            media: {
                type: 'IMAGE',
                url: mediaUrl
            }
        };
    }
}

module.exports = ProductImageHandler;
