const WhatsAppTextNormalizer =
    require('./WhatsAppTextNormalizer');

class WhatsAppProductContextResolver {
    constructor() {
        this.normalizer =
            new WhatsAppTextNormalizer();
    }

    resolve(text, products) {
        if (
            !Array.isArray(products) ||
            products.length === 0
        ) {
            return null;
        }

        let value =
            this.normalizer
                .normalize(text)
                .trim()
                .toLowerCase();

        if (!value || value.length > 60) {
            return null;
        }

        /*
         * Natural selection wrappers.
         *
         * Hanya wrapper percakapan yang dibuang.
         * Ukuran, nomor, dan pilihan produk
         * tetap utuh.
         */
        value = value
            .replace(
                /^(?:ganti|ubah)\s+(?:ke|jadi)\s+/i,
                ''
            )
            .replace(
                /^pilih\s+/i,
                ''
            )
            .replace(
                /\s+(?:aja|saja|deh|dong|ya)[?!.]*$/i,
                ''
            )
            .trim();

        if (
            /^(?:berapa|berapa\s+harganya|harganya|harga|stoknya|stok|ada)\??$/i
                .test(value)
        ) {
            return products.length === 1
                ? {
                    action: 'INQUIRY',
                    product: products[0]
                }
                : {
                    action: 'AMBIGUOUS_INQUIRY',
                    products
                };
        }

        if (
            /^(?:(?:yang\s+)?(?:itu|tadi|tersebut)\s+)?(?:(?:boleh\s+)?(?:lihat|liat)\s+|minta\s+)?(?:foto(?:nya)?|gambar(?:nya)?)(?:\s+dong)?\??$/i
                .test(value)
        ) {
            return products.length === 1
                ? {
                    action: 'IMAGE',
                    product: products[0]
                }
                : {
                    action: 'AMBIGUOUS_IMAGE',
                    products
                };
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

        const ordinal =
            value.match(
                /^(?:yang\s+)?(?:nomor\s+|no\.?\s*)?(pertama|kedua|ketiga|keempat|satu|dua|tiga|empat)$/
            );

        if (ordinal) {
            const index =
                ordinalMap[ordinal[1]] - 1;

            return products[index]
                ? {
                    action: 'SELECT',
                    product: products[index]
                }
                : null;
        }

        /*
         * Natural weight expressions.
         *
         * Convert customer-facing weight language into
         * canonical grams before matching product names.
         *
         * IMPORTANT:
         * We only select when exactly one product in the
         * active context has that exact weight.
         * Never choose the nearest available size.
         */
        const weightInGrams =
            this.parseWeightInGrams(value);

        if (weightInGrams !== null) {
            const weightMatches =
                products.filter(product =>
                    this.productHasWeight(
                        product,
                        weightInGrams
                    )
                );

            if (
                weightMatches.length === 1
            ) {
                return {
                    action: 'SELECT',
                    product:
                        weightMatches[0]
                };
            }

            return null;
        }

        const numeric =
            value.match(
                /^(?:yang\s+|anu\s+)?(?:nomor\s+|no\.?\s*)?(\d+)\s*(?:gr|g|gram)?$/
            );

        if (numeric) {
            const number =
                numeric[1];

            const sizeMatches =
                products.filter(product =>
                    new RegExp(
                        `\\b${number}\\s*(?:gr|g|gram)?\\b`,
                        'i'
                    ).test(
                        String(product.name || '')
                    )
                );

            if (sizeMatches.length === 1) {
                return {
                    action: 'SELECT',
                    product: sizeMatches[0]
                };
            }

            const index =
                Number(number) - 1;

            if (
                number.length <= 2 &&
                products[index]
            ) {
                return {
                    action: 'SELECT',
                    product: products[index]
                };
            }

            return null;
        }

        if (
            /^(?:yang\s+)?(?:gede|besar)$/i
                .test(value)
        ) {
            const ranked =
                this.rankBySize(products);

            if (ranked.length >= 2) {
                return {
                    action: 'SELECT',
                    product:
                        ranked[ranked.length - 1].product
                };
            }
        }

        if (
            /^(?:yang\s+)?(?:kecil)$/i
                .test(value)
        ) {
            const ranked =
                this.rankBySize(products);

            if (ranked.length >= 2) {
                return {
                    action: 'SELECT',
                    product:
                        ranked[0].product
                };
            }
        }

        return null;
    }

    parseWeightInGrams(text) {
        let value =
            String(text || '')
                .trim()
                .toLowerCase();

        value = value
            .replace(
                /^(?:yang\s+|anu\s+)?/,
                ''
            )
            .trim();

        const words = {
            'setengah kilo': 500,
            'setengah kg': 500,
            'separuh kilo': 500,
            'separuh kg': 500,
            'seperempat kilo': 250,
            'seperempat kg': 250
        };

        if (
            Object.prototype
                .hasOwnProperty.call(
                    words,
                    value
                )
        ) {
            return words[value];
        }

        const fraction =
            value.match(
                /^(1\s*\/\s*2|1\s*\/\s*4)\s*(?:kg|kilo|kilogram)$/
            );

        if (fraction) {
            return fraction[1]
                .replace(/\s/g, '') ===
                    '1/2'
                ? 500
                : 250;
        }

        const metric =
            value.match(
                /^(\d+(?:[.,]\d+)?)\s*(kg|kilo|kilogram|gr|g|gram|grams)$/
            );

        if (!metric) {
            return null;
        }

        let amount =
            Number(
                metric[1]
                    .replace(',', '.')
            );

        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {
            return null;
        }

        if (
            [
                'kg',
                'kilo',
                'kilogram'
            ].includes(metric[2])
        ) {
            amount *= 1000;
        }

        return Number.isInteger(amount)
            ? amount
            : null;
    }

    productHasWeight(
        product,
        grams
    ) {
        const name =
            String(
                product?.name || ''
            );

        const matches =
            [
                ...name.matchAll(
                    /\b(\d+(?:[.,]\d+)?)\s*(kg|kilogram|gr|g|gram|grams)\b/gi
                )
            ];

        return matches.some(match => {
            let amount =
                Number(
                    match[1]
                        .replace(',', '.')
                );

            if (
                !Number.isFinite(amount)
            ) {
                return false;
            }

            if (
                match[2]
                    .toLowerCase() ===
                    'kg' ||
                match[2]
                    .toLowerCase() ===
                    'kilogram'
            ) {
                amount *= 1000;
            }

            return amount === grams;
        });
    }

    rankBySize(products) {
        return products
            .map(product => {
                const match =
                    String(product.name || '')
                        .match(
                            /\b(\d+(?:[.,]\d+)?)\s*(kg|gr|g|gram|ml|l|liter)\b/i
                        );

                if (!match) {
                    return null;
                }

                let value =
                    Number(
                        match[1].replace(',', '.')
                    );

                const unit =
                    match[2].toLowerCase();

                if (unit === 'kg') {
                    value *= 1000;
                }

                if (
                    unit === 'l' ||
                    unit === 'liter'
                ) {
                    value *= 1000;
                }

                return {
                    product,
                    value
                };
            })
            .filter(Boolean)
            .sort(
                (a, b) =>
                    a.value - b.value
            );
    }
}

module.exports =
    WhatsAppProductContextResolver;
