class PasarPintarAINaturalResponse {
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
            'Ada kak. Ini beberapa pilihan yang cocok:';

        const outro =
            this.sanitizeStyle(
                style.catalogOutro
            ) ||
            'Kalau ada yang menarik, sebut nama atau nomornya ya kak.';

        const lines =
            products.map(
                (product, index) =>
                    `${index + 1}. ` +
                    `${product.name} — ` +
                    `${this.rupiah(product.price)} — ` +
                    `stok ${Number(product.stock)}`
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
