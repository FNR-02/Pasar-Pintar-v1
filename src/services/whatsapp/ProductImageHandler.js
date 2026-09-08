const ProductInquiryHandler =
    require('./ProductInquiryHandler');
const ProductFuzzyMatcher =
    require('./ProductFuzzyMatcher');
const WhatsAppTextNormalizer =
    require('./WhatsAppTextNormalizer');

class ProductImageHandler {
    constructor(pool) {
        this.pool = pool;
        this.inquiry =
            new ProductInquiryHandler(pool);
        this.fuzzyMatcher =
            new ProductFuzzyMatcher();
        this.textNormalizer =
            new WhatsAppTextNormalizer();
    }

    parseRequest(text) {
        let value =
            this.textNormalizer.normalize(text);

        value = value.replace(
            /\b(boleh|saya|aku|minta|tolong|lihat|liat|lihatkan|kirim|kirimkan|gambar|gambarnya|foto|fotonya|photo|produk|dong|ya+|nih)\b/g,
            ' '
        );

        value =
            value
                .replace(/\s+/g, ' ')
                .trim();

        return this.inquiry.parseInquiryRequest(value);
    }

    parseMultiRequest(text) {
        let value =
            this.textNormalizer.normalize(text);

        value = value.replace(
            /\b(boleh|saya|aku|minta|tolong|lihat|liat|lihatkan|kirim|kirimkan|gambar|gambarnya|foto|fotonya|photo|produk|dong|ya+|nih)\b/g,
            ' '
        );

        value =
            value
                .replace(/\s+/g, ' ')
                .trim();

        const parts =
            value
                .split(/\s+(?:sama|dan)\s+/i)
                .map(part => part.trim())
                .filter(Boolean);

        if (
            parts.length < 2 ||
            parts.length > 4
        ) {
            return null;
        }

        const targets =
            parts
                .map(part =>
                    this.inquiry
                        .parseInquiryRequest(part)
                        .productTerm
                )
                .filter(Boolean);

        if (targets.length !== parts.length) {
            return null;
        }

        return targets;
    }

    resolveSelection(text, products) {
        const value =
            String(text || '')
                .trim()
                .toLowerCase();

        if (
            !Array.isArray(products) ||
            products.length === 0 ||
            value.length > 40
        ) {
            return null;
        }

        const ordinalMap = {
            pertama: 1,
            satu: 1,
            kedua: 2,
            dua: 2,
            ketiga: 3,
            tiga: 3,
            keempat: 4,
            empat: 4
        };

        const ordinalMatch =
            value.match(
                /^(?:yang\s+)?(pertama|kedua|ketiga|keempat)$/
            );

        if (ordinalMatch) {
            const index =
                ordinalMap[ordinalMatch[1]] - 1;

            return products[index] || null;
        }

        const numberChoice =
            value.match(
                /^(?:yang\s+)?(?:nomor\s+|no\.?\s*)?(\d+)$/
            );

        if (numberChoice) {
            const number =
                Number(numberChoice[1]);

            if (
                number >= 1 &&
                number <= products.length
            ) {
                return products[number - 1];
            }
        }

        const sizeMatch =
            value.match(
                /^(?:yang\s+)?(\d+)\s*(gr|g|gram|kg|ml|l|liter|pcs|pc)?$/
            );

        if (sizeMatch) {
            const amount =
                sizeMatch[1];

            const matches =
                products.filter(product =>
                    new RegExp(
                        `\\b${amount}\\s*(?:gr|g|gram|kg|ml|l|liter|pcs|pc)?\\b`,
                        'i'
                    ).test(
                        String(product.name || '')
                    )
                );

            if (matches.length === 1) {
                return matches[0];
            }
        }

        const nameQuery =
            value.replace(/^yang\s+/, '').trim();

        if (nameQuery) {
            const queryTokens =
                nameQuery.split(/\s+/).filter(Boolean);

            const matches =
                products.filter(product => {
                    const productTokens =
                        String(product.name || '')
                            .toLowerCase()
                            .replace(/[^a-z0-9\s]/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim()
                            .split(' ')
                            .filter(Boolean);

                    return queryTokens.every(
                        token => productTokens.includes(token)
                    );
                });

            if (matches.length === 1) {
                return matches[0];
            }
        }

        return null;
    }

    async handleSelectedProduct({ productId }) {
        if (!productId) {
            return {
                status: 'not_found',
                products: [],
                responseText:
                    'Produknya belum ketemu di katalog Pasar Pintar kak. Coba sebut nama produknya lagi ya.'
            };
        }

        const result =
            await this.pool.query(
                `
                SELECT
                    p.id,
                    p.name,
                    p.image_url,
                    p.selling_unit,
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
                WHERE p.id = $1
                  AND p.status = 'ACTIVE'
                  AND p.customer_visible = TRUE
                LIMIT 1
                `,
                [productId]
            );

        if (!result.rowCount) {
            return {
                status: 'not_found',
                products: [],
                responseText:
                    'Produknya belum ketemu di katalog Pasar Pintar kak. Coba sebut nama produknya lagi ya.'
            };
        }

        const product =
            result.rows[0];

        if (!product.image_url) {
            return {
                status: 'image_not_available',
                products: [product],
                responseText:
                    `Maaf kak, foto ${product.name} belum tersedia saat ini.`
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
            products: [product],
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

    async resolveMultiRequest({ text }) {
        const targets =
            this.parseMultiRequest(text);

        if (!targets) {
            return null;
        }

        const results = [];

        for (const target of targets) {
            const result =
                await this.handle({
                    text: `foto ${target}`
                });

            results.push({
                target,
                status: result.status,
                products: result.products || [],
                responseText:
                    result.responseText || '',
                media:
                    result.media || null
            });
        }

        return {
            status: 'multi_product',
            targets,
            results
        };
    }

    async handleMultiRequest({ text }) {
        const resolved =
            await this.resolveMultiRequest({
                text
            });

        if (!resolved) {
            return null;
        }

        const ambiguousResults =
            resolved.results.filter(
                item =>
                    item.status ===
                    'multiple_products'
            );

        if (ambiguousResults.length > 1) {
            const names =
                ambiguousResults.map(
                    item => item.target
                );

            return {
                status:
                    'multi_product_unresolved',
                products: [],
                responseText:
                    'Ada beberapa pilihan untuk ' +
                    names.join(' dan ') +
                    ' kak. Pilih salah satu produk atau variannya dulu ya.'
            };
        }

        const ambiguous =
            ambiguousResults[0];

        if (ambiguous) {
            const choices =
                ambiguous.products.map(
                    (product, index) =>
                        `${index + 1}. ${product.name}`
                );

            const resolvedProducts =
                resolved.results
                    .filter(
                        item =>
                            item.status === 'found' &&
                            item.products.length === 1
                    )
                    .map(item => ({
                        id: item.products[0].id,
                        name: item.products[0].name
                    }));

            return {
                status:
                    'multi_product_need_selection',
                products:
                    ambiguous.products,
                resolvedProducts,
                pendingTarget:
                    ambiguous.target,
                responseText:
                    `Boleh kak 👍 Untuk ${ambiguous.target} ada beberapa pilihan:\n\n` +
                    choices.join('\n') +
                    '\n\nMau yang mana kak?'
            };
        }

        const missing =
            resolved.results.filter(
                item =>
                    item.status === 'not_found'
            );

        if (missing.length) {
            return {
                status:
                    'multi_product_not_found',
                products: [],
                responseText:
                    `Yang ${missing[0].target} belum ketemu di katalog Pasar Pintar kak. Coba sebut nama produknya lagi ya.`
            };
        }

        const found =
            resolved.results.filter(
                item =>
                    item.status === 'found' &&
                    item.products.length === 1
            );

        if (found.length !== resolved.results.length) {
            return {
                status:
                    'multi_product_unresolved',
                products: [],
                responseText:
                    'Ada produk yang belum bisa aku pastikan kak. Coba sebut produknya satu per satu ya.'
            };
        }

        return {
            status:
                'multi_product_ready',
            products:
                found.map(
                    item => item.products[0]
                ),
            mediaItems:
                found.map(item => ({
                    productId:
                        item.products[0].id,
                    name:
                        item.products[0].name,
                    media:
                        item.media,
                    responseText:
                        item.responseText
                })),
            responseText:
                'Siap kak, ini fotonya ya 😊'
        };
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
                    'Boleh kak 😊 Mau lihat foto produk apa?'
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

        if (products.length === 0) {
            const fuzzyResult =
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
                    ORDER BY p.name
                    LIMIT 500
                    `
                );

            products =
                fuzzyResult.rows.filter(row =>
                    this.fuzzyMatcher.matches(
                        searchTerm,
                        row.name
                    )
                );
        }

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
                    `Yang ${searchTerm} belum ketemu di katalog Pasar Pintar kak. Coba sebut nama produknya lagi ya.`
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
                    `Boleh kak 👍 Untuk ${searchTerm} ada beberapa pilihan:\n\n` +
                    choices.join('\n') +
                    '\n\nMau yang mana kak?'
            };
        }

        const product =
            products[0];

        if (!product.image_url) {
            return {
                status: 'image_not_available',
                products,
                responseText:
                    `Maaf kak, foto ${product.name} belum tersedia saat ini.`
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
