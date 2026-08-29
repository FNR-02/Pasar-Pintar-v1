class ProductOrderDraftHandler {
    constructor(pool) {
        this.pool = pool;
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
            String(text || '')
                .trim()
                .toLowerCase();

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

        if (!quantityBeforeUnit) {
            const standaloneNumbers =
                [
                    ...value.matchAll(
                        /\b(\d{1,3})\b/g
                    )
                ];

            const candidate =
                standaloneNumbers.find(match => {
                    const number =
                        Number(match[1]);

                    if (
                        packSizeMatch &&
                        Number(packSizeMatch[1]) ===
                            number
                    ) {
                        return false;
                    }

                    return true;
                });

            if (candidate) {
                quantity =
                    Number(candidate[1]);
            }
        }

        let productTerm = value;

        productTerm =
            productTerm.replace(
                /\b(saya|aku|mau|ingin|beli|pesan|order|tolong|dong|ya+|minta|yang|yg|aja|saja|deh)\b/g,
                ' '
            );

        if (quantityBeforeUnit) {
            productTerm =
                productTerm.replace(
                    quantityBeforeUnit[0],
                    ' '
                );
        }

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
                .replace(
                    /\b\d{1,3}\b/g,
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

    async handle({ text }) {
        const parsed =
            this.parseOrderRequest(text);

        if (!parsed.productTerm) {
            return {
                status: 'need_product_name',
                draft: null,
                responseText:
                    'Mau pesan produk apa?'
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
                    'Jumlahnya bisa dari 1 sampai 100 ya.'
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
                    `Produk "${parsed.productTerm}"${requestedVariant} belum ditemukan.`
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

            const choices =
                (
                    variantProducts.length
                        ? variantProducts
                        : products
                ).map(
                    (product, index) => {
                        const label =
                            String(
                                product.variantLabel || ''
                            ).trim() ||
                            (
                                product.packSizeValue !== null &&
                                product.packSizeUnit
                                    ? `${product.packSizeValue} ${String(
                                        product.packSizeUnit
                                      ).toLowerCase()}`
                                    : product.name
                            );

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
                    ? (
                        String(
                            exampleProduct.variantLabel || ''
                        ).trim() ||
                        (
                            exampleProduct.packSizeValue !== null &&
                            exampleProduct.packSizeUnit
                                ? `${exampleProduct.packSizeValue} ${String(
                                    exampleProduct.packSizeUnit
                                  ).toLowerCase()}`
                                : exampleProduct.name
                        )
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
                responseText:
                    'Ada beberapa pilihan nih:\n\n' +
                    choices.join('\n') +
                    '\n\nMau yang mana?' +
                    (
                        exampleVariant
                            ? ` Contohnya: beli ${parsed.productTerm} ${exampleVariant} 2 ${exampleUnit}.`
                            : ''
                    )
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
                'Siap, ini pesanan sementara kamu:\n\n' +
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
                `Harga satuan: ${rupiah(price)}\n` +
                `Subtotal: ${rupiah(subtotal)}\n\n` +
                'Pesanannya belum dibuat ya.'
        };
    }
}

module.exports = ProductOrderDraftHandler;
