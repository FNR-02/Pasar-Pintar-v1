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

        const value =
            this.normalizer
                .normalize(text)
                .trim()
                .toLowerCase();

        if (!value || value.length > 60) {
            return null;
        }

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
            /^(?:(?:boleh\s+)?(?:lihat|liat)\s+|minta\s+)?(?:foto(?:nya)?|gambar(?:nya)?)(?:\s+dong)?\??$/i
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
