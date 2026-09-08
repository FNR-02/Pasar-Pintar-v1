const ProductFuzzyMatcher =
    require('./ProductFuzzyMatcher');
const WhatsAppTextNormalizer =
    require('./WhatsAppTextNormalizer');

class ProductOrderDraftHandler {
    constructor(pool) {
        this.pool = pool;
        this.fuzzyMatcher =
            new ProductFuzzyMatcher();
        this.normalizer =
            new WhatsAppTextNormalizer();
    }

    normalizeSellingUnit(value) {
        const unit =
            String(value || '')
                .trim()
                .toLowerCase();

        const aliases = {
            pcs: 'PCS',
            pc: 'PCS',
            piece: 'PCS',
            pieces: 'PCS',
            pack: 'PACK',
            bungkus: 'BUNGKUS',
            ikat: 'IKAT',
            botol: 'BOTOL',
            dus: 'DUS',
            kardus: 'DUS',
            karung: 'KARUNG',
            sachet: 'SACHET',
            saset: 'SACHET',
            kaleng: 'KALENG',
            tray: 'TRAY',
            papan: 'PAPAN'
        };

        return aliases[unit] || null;
    }

    getCustomerVariantLabel(product) {
        const explicit =
            String(
                product?.variantLabel ||
                product?.variant_label ||
                ''
            ).trim();

        if (explicit) {
            return explicit;
        }

        const name =
            String(product?.name || '');

        const sizeInName =
            name.match(
                /\b(\d+(?:[.,]\d+)?)\s*(kg|kilogram|gr|g|gram|ml|l|liter|litre)\b/i
            );

        if (sizeInName) {
            return (
                `${sizeInName[1]}${sizeInName[2]}`
            );
        }

        const packSizeValue =
            product?.packSizeValue ??
            product?.pack_size_value;

        const packSizeUnit =
            product?.packSizeUnit ??
            product?.pack_size_unit;

        if (
            packSizeValue !== null &&
            packSizeValue !== undefined &&
            packSizeUnit
        ) {
            return (
                `${Number(packSizeValue)} ` +
                `${String(packSizeUnit).toLowerCase()}`
            );
        }

        return name;
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

    parseOrderRequest(text) {
        const value =
            this.normalizer.normalize(text);

        const sellingUnitPattern =
            '(pcs|pc|piece|pieces|pack|bungkus|ikat|botol|dus|kardus|karung|sachet|saset|kaleng|tray|papan)';

        const packSizeUnitPattern =
            '(g|gr|gram|grams|kg|kilogram|ml|liter|litre|l|pcs|pc)';

        let quantity = 1;
        let sellingUnit = null;
        let packSizeValue = null;
        let packSizeUnit = null;

        const quantityBeforeUnit =
            value.match(
                new RegExp(
                    `\\b(\\d{1,3})\\s*${sellingUnitPattern}\\b`,
                    'i'
                )
            );

        if (quantityBeforeUnit) {
            quantity =
                Number(quantityBeforeUnit[1]);

            sellingUnit =
                this.normalizeSellingUnit(
                    quantityBeforeUnit[2]
                );
        }

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

        let standaloneQuantityMatch = null;

        if (!quantityBeforeUnit) {
            const standaloneNumbers =
                [
                    ...value.matchAll(
                        /\b(\d{1,3})\b/g
                    )
                ];

            const candidates =
                standaloneNumbers.filter(match => {
                    const number =
                        Number(match[1]);

                    if (
                        packSizeMatch &&
                        Number(packSizeMatch[1]) ===
                            number
                    ) {
                        return false;
                    }

                    return (
                        number >= 1 &&
                        number <= 100
                    );
                });

            if (candidates.length === 1) {
                standaloneQuantityMatch =
                    candidates[0];

                quantity =
                    Number(
                        standaloneQuantityMatch[1]
                    );
            }
        }

        let productTerm = value;

        if (quantityBeforeUnit) {
            productTerm =
                productTerm.replace(
                    quantityBeforeUnit[0],
                    ' '
                );
        } else if (standaloneQuantityMatch) {
            const index =
                standaloneQuantityMatch.index;

            productTerm =
                productTerm.slice(0, index) +
                ' ' +
                productTerm.slice(
                    index +
                    standaloneQuantityMatch[0].length
                );
        }

        productTerm =
            productTerm.replace(
                /\b(saya|aku|mau|ingin|beli|pesan|order|tolong|dong|ya+|minta|yang|yg|aja|saja|deh)\b/g,
                ' '
            );
        productTerm =
            productTerm.replace(
                /\btotal(?:nya)?\s+(?:(?:jadi)\s+)?berapa\b[?!.]*/g,
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
                .replace(
                    /\b(pcs|pc|piece|pieces|pack|bungkus|ikat|botol|dus|kardus|karung|sachet|saset|kaleng|tray|papan)\b/g,
                    ' '
                )
                .replace(/\s+/g, ' ')
                .trim()
                .replace(/\bsedap\b/g, 'sedaap');

        return {
            productTerm,
            quantity,
            sellingUnit,
            packSizeValue,
            packSizeUnit
        };
    }

    async handleSelectedProduct({
        productId,
        quantity = 1
    }) {
        const parsedQuantity =
            Number(quantity);

        if (
            !productId ||
            !Number.isInteger(parsedQuantity) ||
            parsedQuantity < 1 ||
            parsedQuantity > 100
        ) {
            return {
                status: 'invalid_quantity',
                draft: null,
                responseText:
                    'Jumlah pesanannya bisa dari 1 sampai 100 ya kak.'
            };
        }

        const result =
            await this.pool.query(
                `
                SELECT
                    p.id,
                    p.sku,
                    p.name,
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
                WHERE p.id = $1
                  AND p.status = 'ACTIVE'
                  AND p.customer_visible = TRUE
                LIMIT 1
                `,
                [productId]
            );

        if (result.rowCount === 0) {
            return {
                status: 'product_not_found',
                draft: null,
                responseText:
                    'Produk yang dipilih sudah tidak tersedia di katalog kak.'
            };
        }

        const product =
            result.rows[0];

        const price =
            Number(product.price);

        const stock =
            Number(product.stock);

        if (stock < parsedQuantity) {
            return {
                status: 'insufficient_stock',
                draft: null,
                responseText:
                    `Stok ${product.name} sekarang tinggal ${stock} kak, jadi belum cukup untuk jumlah yang diminta.`
            };
        }

        const subtotal =
            price * parsedQuantity;

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
            sellingUnit:
                String(
                    product.selling_unit || 'PCS'
                ).toUpperCase(),
            packSizeValue:
                product.pack_size_value === null ||
                product.pack_size_value === undefined
                    ? null
                    : Number(
                        product.pack_size_value
                    ),
            packSizeUnit:
                product.pack_size_unit
                    ? String(
                        product.pack_size_unit
                      ).toUpperCase()
                    : null,
            quantity: parsedQuantity,
            unitPrice: price,
            subtotal,
            availableStock: stock
        };

        return {
            status: 'draft_ready',
            draft,
            responseText:
                'Siap kak 👍 Aku catat dulu pesanannya:\n\n' +
                `${product.name}\n` +
                `Jumlah: ${parsedQuantity} ${String(
                    product.selling_unit || 'PCS'
                ).toLowerCase()}\n` +
                (
                    product.pack_size_value &&
                    product.pack_size_unit
                        ? `Isi: ${Number(
                            product.pack_size_value
                          )} ${String(
                            product.pack_size_unit
                          ).toLowerCase()}\n`
                        : ''
                ) +
                `Harga: ${rupiah(price)} / ${String(
                    product.selling_unit || 'PCS'
                ).toLowerCase()}\n` +
                `Total sementara: ${rupiah(subtotal)}\n\n` +
                'Kalau sudah sesuai, balas "konfirmasi" ya kak.'
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
                    'Boleh kak 😊 Mau pesan produk apa?'
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
                    'Jumlah pesanannya bisa dari 1 sampai 100 ya kak.'
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
              AND p.customer_visible = TRUE
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
            [`%${parsed.productTerm.split(/\s+/).filter(Boolean).join('%')}%`]
        );

        let matchedProducts =
            result.rows;

        if (matchedProducts.length === 0) {
            const fuzzyResult =
                await this.pool.query(
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
                      AND p.customer_visible = TRUE
                    ORDER BY
                        CASE
                            WHEN p.parent_product_id IS NOT NULL
                            THEN 0
                            ELSE 1
                        END,
                        p.name
                    LIMIT 500
                    `
                );

            matchedProducts =
                this.fuzzyMatcher.filter(
                    parsed.productTerm,
                    fuzzyResult.rows
                );
        }

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

                    const structuredMatch =
                        rowValue ===
                            parsed.packSizeValue &&
                        rowUnit ===
                            parsed.packSizeUnit;

                    if (structuredMatch) {
                        return true;
                    }

                    const unitPatterns = {
                        GRAM:
                            '(?:g|gr|gram|grams)',
                        KG:
                            '(?:kg|kilogram)',
                        ML:
                            '(?:ml)',
                        LITER:
                            '(?:l|liter|litre)',
                        PCS:
                            '(?:pcs|pc)'
                    };

                    const unitPattern =
                        unitPatterns[
                            parsed.packSizeUnit
                        ];

                    if (!unitPattern) {
                        return false;
                    }

                    const sizeValue =
                        String(
                            parsed.packSizeValue
                        ).replace(
                            '.',
                            '[.,]'
                        );

                    return new RegExp(
                        `\\b${sizeValue}\\s*${unitPattern}\\b`,
                        'i'
                    ).test(
                        String(row.name || '')
                    );
                });
        }

        if (parsed.sellingUnit) {
            matchedProducts =
                matchedProducts.filter(row =>
                    String(
                        row.selling_unit || 'PCS'
                    ).toUpperCase() ===
                        parsed.sellingUnit
                );
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
                status: 'product_not_found',
                draft: null,
                responseText:
                    `Yang ${parsed.productTerm}${requestedVariant} belum ketemu di katalog Pasar Pintar kak.`
            };
        }

        if (matchedProducts.length > 1) {
            const products =
                matchedProducts.map(row => ({
                    id: row.id,
                    sku: row.sku,
                    name: row.name,
                    parentProductId:
                        row.parent_product_id || null,
                    variantLabel:
                        row.variant_label || null,
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

            const variantProducts =
                products.filter(product =>
                    Boolean(
                        product.parentProductId
                    )
                );

            const choiceProducts =
                variantProducts.length
                    ? variantProducts
                    : products;

            const candidateLabels =
                choiceProducts.map(product =>
                    this.getCustomerVariantLabel(
                        product
                    )
                );

            const labelCounts =
                candidateLabels.reduce(
                    (counts, label) => {
                        const key =
                            String(label || '')
                                .trim()
                                .toLowerCase();
                        counts[key] =
                            (counts[key] || 0) + 1;
                        return counts;
                    },
                    {}
                );

            const choices =
                choiceProducts.map(
                    (product, index) => {
                        const candidateLabel =
                            candidateLabels[index];

                        const key =
                            String(candidateLabel || '')
                                .trim()
                                .toLowerCase();

                        const label =
                            product.name;

                        const unit =
                            String(
                                product.sellingUnit || 'PCS'
                            ).toLowerCase();

                        const stockText =
                            product.stock > 0
                                ? `stok ${product.stock} ${unit}`
                                : 'stok habis';

                        return (
                            `${index + 1}. ${label} — ` +
                            `${rupiah(product.price)} — ` +
                            stockText
                        );
                    }
                );

            const exampleProduct =
                (
                    variantProducts.find(
                        product =>
                            product.stock > 0
                    ) ||
                    variantProducts[0] ||
                    products.find(
                        product =>
                            product.stock > 0
                    ) ||
                    products[0]
                );

            const exampleVariant =
                exampleProduct
                    ? this.getCustomerVariantLabel(
                        exampleProduct
                    )
                    : '';

            const exampleUnit =
                exampleProduct
                    ? String(
                        exampleProduct.sellingUnit || 'PCS'
                      ).toLowerCase()
                    : '';

            return {
                status: 'multiple_products',
                draft: null,
                products,
                quantity: parsed.quantity,
                responseText:
                    'Ada beberapa pilihan kak:\n\n' +
                    choices.join('\n') +
                    '\n\nMau yang mana kak? Balas nomor pilihannya atau sebut ukuran/namanya ya.'
            };
        }

        const product =
            matchedProducts[0];

        const price =
            Number(product.price);

        const stock =
            Number(product.stock);

        if (stock < parsed.quantity) {
            return {
                status: 'insufficient_stock',
                draft: null,
                responseText:
                    `Stok ${product.name} sekarang tinggal ${stock} kak, jadi belum cukup untuk jumlah yang diminta.`
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
            sellingUnit:
                String(
                    product.selling_unit || 'PCS'
                ).toUpperCase(),
            packSizeValue:
                product.pack_size_value === null ||
                product.pack_size_value === undefined
                    ? null
                    : Number(
                        product.pack_size_value
                    ),
            packSizeUnit:
                product.pack_size_unit
                    ? String(
                        product.pack_size_unit
                      ).toUpperCase()
                    : null,
            quantity: parsed.quantity,
            unitPrice: price,
            subtotal,
            availableStock: stock
        };

        return {
            status: 'draft_ready',
            draft,
            responseText:
                'Siap kak 👍 Aku catat dulu pesanannya:\n\n' +
                `${product.name}\n` +
                `Jumlah: ${parsed.quantity} ${String(
                    product.selling_unit || 'PCS'
                ).toLowerCase()}\n` +
                (
                    product.pack_size_value &&
                    product.pack_size_unit
                        ? `Isi: ${Number(
                            product.pack_size_value
                          )} ${String(
                            product.pack_size_unit
                          ).toLowerCase()}\n`
                        : ''
                ) +
                `Harga: ${rupiah(price)} / ${String(product.selling_unit || 'PCS').toLowerCase()}\n` +
                `Total sementara: ${rupiah(subtotal)}\n\n` +
                'Kalau sudah sesuai, balas "konfirmasi" ya kak.'
        };
    }
}

module.exports = ProductOrderDraftHandler;
