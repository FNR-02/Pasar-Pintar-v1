class PasarPintarAINaturalResponse {
    normalizeLanguage(value) {
        const language =
            String(value || '')
                .trim()
                .toLowerCase();

        return ['id', 'su', 'en']
            .includes(language)
                ? language
                : 'id';
    }

    catalogText(language, key) {
        const copy = {
            id: {
                intro:
                    'Ada kak. Ini beberapa pilihan yang cocok:',
                outro:
                    'Kalau ada yang menarik, sebut nama atau nomornya ya kak.',
                stock:
                    'stok'
            },
            su: {
                intro:
                    'Aya. Ieu sababaraha pilihan anu cocog:',
                outro:
                    'Upami aya anu dipikaresep, sebatkeun nami atanapi nomerna.',
                stock:
                    'stok'
            },
            en: {
                intro:
                    'Here are some options that match:',
                outro:
                    'If you like one, just tell me the name or number.',
                stock:
                    'stock'
            }
        };

        return copy[language]?.[key] ||
            copy.id[key];
    }

    rupiah(value) {
        return new Intl.NumberFormat(
            'id-ID',
            {
                style: 'currency',
                currency: 'IDR',
                maximumFractionDigits: 0
            }
        ).format(Number(value || 0));
    }

    sanitizeStyle(value) {
        const text =
            String(value || '')
                .replace(/[\r\n]+/g, ' ')
                .trim();

        if (!text || text.length > 240) {
            return null;
        }

        return text;
    }

    buildGeneral({
        conversationStyle = null
    } = {}) {
        const style =
            conversationStyle &&
            typeof conversationStyle === 'object'
                ? conversationStyle
                : {};

        const text =
            this.sanitizeStyle(
                style.generalReply
            );

        /*
         * Style AI tidak menjadi authority
         * untuk fakta bisnis.
         *
         * Ini guard kecil terhadap claim faktual,
         * bukan kamus untuk memahami bahasa customer.
         */
        const unsafe =
            text &&
            (
                /(?:\brp\b|\bharga\b|\bstok\b|\btotal\b|\bsaldo\b|\bpromo\b|\blunas\b|\bberhasil\b)/i
                    .test(text) ||
                /\d{2,}/
                    .test(text)
            );

        if (!text || unsafe) {
            return {
                status: 'fallback',
                responseText:
                    'Boleh kak, silakan lihat-lihat dulu. Kalau ada yang dicari, tinggal bilang ya.'
            };
        }

        return {
            status: 'ready',
            responseText: text
        };
    }

    async build({
        catalogResult,
        conversationStyle = null
    }) {
        const status =
            String(catalogResult?.status || '');

        if (
            ![
                'semantic_catalog',
                'not_found'
            ].includes(status)
        ) {
            return {
                status: 'unsupported',
                responseText: null
            };
        }

        const style =
            conversationStyle &&
            typeof conversationStyle === 'object'
                ? conversationStyle
                : {};

        const language =
            this.normalizeLanguage(
                style.language
            );

        if (status === 'not_found') {
            const text =
                this.sanitizeStyle(
                    style.notFoundText
                );

            if (!text) {
                return {
                    status: 'fallback',
                    responseText:
                        catalogResult?.responseText ||
                        null
                };
            }

            return {
                status: 'ready',
                responseText: text
            };
        }

        const products =
            Array.isArray(catalogResult?.products)
                ? catalogResult.products
                : [];

        if (products.length === 0) {
            return {
                status: 'fallback',
                responseText:
                    catalogResult?.responseText ||
                    null
            };
        }

        const intro =
            this.sanitizeStyle(
                style.catalogIntro
            ) ||
            this.catalogText(
                language,
                'intro'
            );

        const outro =
            this.sanitizeStyle(
                style.catalogOutro
            ) ||
            this.catalogText(
                language,
                'outro'
            );

        const lines =
            products.map(
                (product, index) =>
                    `${index + 1}. ` +
                    `${product.name} — ` +
                    `${this.rupiah(product.price)} — ` +
                    `${this.catalogText(
                        language,
                        'stock'
                    )} ${Number(product.stock)}`
            );

        return {
            status: 'ready',
            responseText:
                intro +
                '\n\n' +
                lines.join('\n') +
                '\n\n' +
                outro
        };
    }
}

module.exports =
    PasarPintarAINaturalResponse;
