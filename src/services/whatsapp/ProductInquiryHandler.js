class ProductInquiryHandler {
    constructor(pool) {
        this.pool = pool;
    }

    normalizePackSizeUnit(value) {
        const unit =
            String(value || '')
                .trim()
                .toLowerCase();

        const aliases = {
            g: 'GRAM',
            gr: 'GRAM',
            gram: 'GRAM',
            grams: 'GRAM',
            kg: 'KG',
            kilogram: 'KG',
            ml: 'ML',
            liter: 'LITER',
            litre: 'LITER',
            l: 'LITER',
            pcs: 'PCS',
            pc: 'PCS'
        };

        return aliases[unit] || null;
    }

    parseInquiryRequest(text) {
        const value =
            String(text || '')
                .trim()
                .toLowerCase();

        const packSizeUnitPattern =
            '(g|gr|gram|grams|kg|kilogram|ml|liter|litre|l|pcs|pc)';

        let packSizeValue = null;
        let packSizeUnit = null;

        const packSizeMatch =
            value.match(
                new RegExp(
                    `\\b(\\d+(?:[.,]\\d+)?)\\s*${packSizeUnitPattern}\\b`,
                    'i'
                )
            );

        if (packSizeMatch) {
            packSizeValue =
                Number(
                    String(packSizeMatch[1])
                        .replace(',', '.')
                );

            packSizeUnit =
                this.normalizePackSizeUnit(
                    packSizeMatch[2]
                );
        }

        let productTerm = value;

        productTerm =
            productTerm.replace(
                /\b(berapa|harga|stok|ada|tersedia|produk|barang|dong|ya|punya|cek|lihat|tolong)\b/g,
                ' '
            );

        if (packSizeMatch) {
            productTerm =
                productTerm.replace(
                    packSizeMatch[0],
                    ' '
                );
        }

        productTerm =
            productTerm
                .replace(/\s+/g, ' ')
                .trim();

        return {
            productTerm,
            packSizeValue,
            packSizeUnit
        };
    }

    extractSearchTerm(text) {
        return this.parseInquiryRequest(
            text
        ).productTerm;
    }

    async handle({ text }) {
        const normalized =
            String(text || '')
                .trim()
                .toLowerCase();

        const isCatalogRequest =
            /^(menu|katalog|catalog)$/i.test(normalized) ||
            /\b(ada|punya)\s+produk\s+apa\s+saja\b/i.test(normalized) ||
            /\bproduk\s+apa\s+saja\b/i.test(normalized);

        if (isCatalogRequest) {
            const result =
                await this.pool.query(
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
                    ORDER BY p.name
                    LIMIT 10
                    `
                );

            const products =
                result.rows.map(row => ({
                    id: row.id,
                    sku: row.sku,
                    name: row.name,
                    price: Number(row.price),
                    stock: Number(row.stock)
                }));

            if (products.length === 0) {
                return {
                    status: 'catalog_empty',
                    products: [],
                    responseText:
                        'Belum ada produk yang tersedia di katalog nih.'
                };
            }

            const rupiah = value =>
                new Intl.NumberFormat(
                    'id-ID',
                    {
                        style: 'currency',
                        currency: 'IDR',
                        maximumFractionDigits: 0
                    }
                ).format(value);

            const lines =
                products.map(
                    (product, index) =>
                        `${index + 1}. ${product.name} — ` +
                        `${rupiah(product.price)} — ` +
                        `stok ${product.stock}`
                );

            return {
                status: 'catalog',
                products,
                responseText:
                    `Katalog Pasar Pintar:\n\n` +
                    lines.join('\n')
            };
        }

        const parsed =
            this.parseInquiryRequest(text);

        const searchTerm =
            parsed.productTerm;

        if (!searchTerm) {
            return {
                status: 'need_product_name',
                products: [],
                responseText:
                    'Mau cek produk apa?'
            };
        }

        const result = await this.pool.query(
            `
            SELECT
                p.id,
                p.sku,
                p.name,
                p.selling_unit,
                p.pack_size_value,
                p.pack_size_unit,
                p.parent_product_id,
                p.variant_label,

                parent.name AS parent_product_name,
                parent.sku AS parent_product_sku,

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

            LEFT JOIN tbl_products parent
                ON parent.id = p.parent_product_id
               AND parent.merchant_id = p.merchant_id

            WHERE p.status = 'ACTIVE'
              AND (
                    p.name ILIKE $1
                    OR parent.name ILIKE $1
                  )

            ORDER BY
                CASE
                    WHEN p.parent_product_id IS NOT NULL
                    THEN 0
                    ELSE 1
                END,
                p.name

            LIMIT 20
            `,
            [`%${searchTerm}%`]
        );

        let matchedProducts =
            result.rows;

        if (
            parsed.packSizeValue !== null &&
            parsed.packSizeUnit
        ) {
            matchedProducts =
                matchedProducts.filter(row => {
                    const rowValue =
                        row.pack_size_value === null ||
                        row.pack_size_value === undefined
                            ? null
                            : Number(
                                row.pack_size_value
                            );

                    const rowUnit =
                        row.pack_size_unit
                            ? String(
                                row.pack_size_unit
                              ).toUpperCase()
                            : null;

                    return (
                        rowValue ===
                            parsed.packSizeValue &&
                        rowUnit ===
                            parsed.packSizeUnit
                    );
                });
        }

        if (matchedProducts.length === 0) {
            const requestedVariant =
                parsed.packSizeValue !== null &&
                parsed.packSizeUnit
                    ? ` ukuran ${parsed.packSizeValue} ${String(
                        parsed.packSizeUnit
                      ).toLowerCase()}`
                    : '';

            return {
                status: 'not_found',
                searchTerm,
                products: [],
                responseText:
                    `Produk "${searchTerm}"${requestedVariant} belum ditemukan.`
            };
        }

        const products =
            matchedProducts.map(row => ({
                id: row.id,
                sku: row.sku,
                name: row.name,
                sellingUnit:
                    String(
                        row.selling_unit || 'PCS'
                    ).toUpperCase(),
                packSizeValue:
                    row.pack_size_value === null ||
                    row.pack_size_value === undefined
                        ? null
                        : Number(
                            row.pack_size_value
                        ),
                packSizeUnit:
                    row.pack_size_unit
                        ? String(
                            row.pack_size_unit
                          ).toUpperCase()
                        : null,
                parentProductId:
                    row.parent_product_id,
                parentProductName:
                    row.parent_product_name,
                variantLabel:
                    row.variant_label,
                price:
                    Number(row.price),
                stock:
                    Number(row.stock)
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

        const variantChildren =
            products.filter(
                product =>
                    product.parentProductId
            );

        const displayProducts =
            variantChildren.length > 0
                ? variantChildren
                : products;

        const lines =
            displayProducts.map(
                (product, index) => {
                    const variantText =
                        product.variantLabel ||
                        (
                            product.packSizeValue !== null &&
                            product.packSizeUnit
                                ? `${product.packSizeValue} ${String(
                                    product.packSizeUnit
                                  ).toLowerCase()}`
                                : product.name
                        );

                    return (
                        `${index + 1}. ${variantText} — ` +
                        `${rupiah(product.price)} — ` +
                        `stok ${product.stock} ${String(
                            product.sellingUnit || 'PCS'
                        ).toLowerCase()}`
                    );
                }
            );

        if (
            parsed.packSizeValue !== null &&
            parsed.packSizeUnit &&
            displayProducts.length === 1
        ) {
            const product =
                displayProducts[0];

            return {
                status: 'found',
                searchTerm,
                products: displayProducts,
                responseText:
                    `${product.name}\n` +
                    `Harga: ${rupiah(product.price)}\n` +
                    `Stok: ${product.stock} ${String(
                        product.sellingUnit || 'PCS'
                    ).toLowerCase()}\n` +
                    (
                        product.packSizeValue !== null &&
                        product.packSizeUnit
                            ? `Isi: ${product.packSizeValue} ${String(
                                product.packSizeUnit
                              ).toLowerCase()}`
                            : ''
                    )
            };
        }

        if (variantChildren.length > 1) {
            return {
                status: 'found',
                searchTerm,
                products: displayProducts,
                responseText:
                    `Ada beberapa pilihan ${searchTerm}:\n\n` +
                    lines.join('\n')
            };
        }

        return {
            status: 'found',
            searchTerm,
            products: displayProducts,
            responseText:
                `Aku nemu ${displayProducts.length} produk:\n\n` +
                lines.join('\n')
        };
    }
}

module.exports = ProductInquiryHandler;
