class PasarPintarProductResolver {
    constructor(semanticCatalogService) {
        if (!semanticCatalogService) {
            throw new Error(
                'semanticCatalogService is required'
            );
        }

        this.semanticCatalogService =
            semanticCatalogService;
    }

    normalize(value) {
        return String(value || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/(\d)([a-z])/g, '$1 $2')
            .replace(/([a-z])(\d)/g, '$1 $2')
            .replace(/\bkilograms?\b/g, 'kg')
            .replace(/\bkilogram\b/g, 'kg')
            .replace(/\bkgs?\b/g, 'kg')
            .replace(/\bgrams?\b/g, 'g')
            .replace(/\bgr\b/g, 'g')
            .replace(/\bliters?\b/g, 'l')
            .replace(/\blitres?\b/g, 'l')
            .replace(/\bltr\b/g, 'l')
            .replace(/\bmilliliters?\b/g, 'ml')
            .replace(/\bmillilitres?\b/g, 'ml')
            .replace(/\bmililiter\b/g, 'ml')
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    tokenize(value) {
        return Array.from(
            new Set(
                this.normalize(value)
                    .split(' ')
                    .filter(Boolean)
                    .filter(token =>
                        token.length >= 2 ||
                        /^\d+$/.test(token) ||
                        [
                            'g',
                            'l'
                        ].includes(token)
                    )
            )
        );
    }

    tokenWeight(token) {
        if (/^\d+(?:\.\d+)?$/.test(token)) {
            return 2.5;
        }

        if (
            [
                'g',
                'kg',
                'ml',
                'l'
            ].includes(token)
        ) {
            return 0.75;
        }

        if (token.length >= 6) {
            return 1.25;
        }

        return 1;
    }

    buildCandidateText(product) {
        return [
            product?.name,
            product?.sellingUnit,
            product?.category,
            product?.parentCategory
        ]
            .filter(Boolean)
            .join(' ');
    }

    scoreCandidate({
        query,
        variant,
        product
    }) {
        const requested =
            this.normalize(
                [query, variant]
                    .filter(Boolean)
                    .join(' ')
            );

        const productName =
            this.normalize(product?.name);

        const candidateText =
            this.normalize(
                this.buildCandidateText(product)
            );

        if (!requested || !candidateText) {
            return 0;
        }

        if (productName === requested) {
            return 1;
        }

        if (productName.includes(requested)) {
            return 0.98;
        }

        const requestedTokens =
            this.tokenize(requested);

        const candidateTokens =
            new Set(
                this.tokenize(candidateText)
            );

        if (requestedTokens.length === 0) {
            return 0;
        }

        let totalWeight = 0;
        let matchedWeight = 0;

        for (const token of requestedTokens) {
            const weight =
                this.tokenWeight(token);

            totalWeight += weight;

            if (candidateTokens.has(token)) {
                matchedWeight += weight;
            }
        }

        let score =
            totalWeight > 0
                ? matchedWeight /
                    totalWeight
                : 0;

        /*
         * Token deskriptif yang disebut pelanggan
         * harus ikut membedakan kandidat.
         *
         * Ini generik, bukan kamus produk.
         * Token deskriptif, merek, warna, ukuran,
         * tipe, atau atribut lain diperlakukan sama.
         */
        const descriptiveTokens =
            requestedTokens.filter(token =>
                !/^\d+(?:\.\d+)?$/.test(token) &&
                ![
                    'g',
                    'kg',
                    'ml',
                    'l'
                ].includes(token) &&
                token.length >= 3
            );

        const missingDescriptive =
            descriptiveTokens.filter(token =>
                !candidateTokens.has(token)
            );

        if (missingDescriptive.length > 0) {
            score -= Math.min(
                0.45,
                missingDescriptive.length * 0.22
            );
        }

        const requestedNumbers =
            requestedTokens.filter(token =>
                /^\d+(?:\.\d+)?$/.test(token)
            );

        const candidateNumbers =
            Array.from(candidateTokens)
                .filter(token =>
                    /^\d+(?:\.\d+)?$/.test(token)
                );

        if (requestedNumbers.length > 0) {
            const numberMatch =
                requestedNumbers.some(number =>
                    candidateNumbers.includes(number)
                );

            if (numberMatch) {
                score += 0.12;
            } else if (
                candidateNumbers.length > 0
            ) {
                score -= 0.35;
            }
        }

        if (
            requestedTokens.every(token =>
                candidateTokens.has(token)
            )
        ) {
            score += 0.12;
        }

        return Math.max(
            0,
            Math.min(1, score)
        );
    }

    async collectCandidates({
        query,
        variant
    }) {
        const combined =
            [query, variant]
                .filter(Boolean)
                .join(' ')
                .trim();

        const tokens =
            this.tokenize(combined)
                .filter(token =>
                    token.length >= 3 ||
                    /^\d+$/.test(token)
                );

        const searchTerms =
            Array.from(
                new Set([
                    combined,
                    ...tokens
                ].filter(Boolean))
            )
                .slice(0, 6);

        const productsById =
            new Map();

        for (const term of searchTerms) {
            const result =
                await this.semanticCatalogService
                    .search({
                        productQuery: term
                    });

            for (
                const product of
                result?.products || []
            ) {
                if (
                    product?.id &&
                    !productsById.has(product.id)
                ) {
                    productsById.set(
                        product.id,
                        product
                    );
                }
            }
        }

        return Array.from(
            productsById.values()
        );
    }

    async resolve({
        query,
        variant = null
    }) {
        const requested =
            this.normalize(
                [query, variant]
                    .filter(Boolean)
                    .join(' ')
            );

        if (!requested) {
            return {
                status: 'product_not_found',
                product: null,
                candidates: []
            };
        }

        const products =
            await this.collectCandidates({
                query,
                variant
            });

        if (products.length === 0) {
            return {
                status: 'product_not_found',
                product: null,
                candidates: []
            };
        }

        const ranked =
            products
                .map(product => ({
                    product,
                    score:
                        this.scoreCandidate({
                            query,
                            variant,
                            product
                        })
                }))
                .sort(
                    (a, b) =>
                        b.score - a.score
                );

        const best =
            ranked[0];

        const second =
            ranked[1] || null;

        const bestScore =
            Number(best?.score || 0);

        const secondScore =
            Number(second?.score || 0);

        const margin =
            bestScore - secondScore;

        const candidates =
            ranked
                .slice(0, 8)
                .map(item => ({
                    ...item.product,
                    resolutionScore:
                        Number(
                            item.score.toFixed(4)
                        )
                }));

        /*
         * Resolve hanya bila cukup kuat.
         *
         * Kandidat tunggal tetap harus mempunyai
         * kemiripan minimum. Jangan memilih produk
         * hanya karena kebetulan satu-satunya hasil.
         */
        const uniquelyStrong =
            bestScore >= 0.58 &&
            (
                !second ||
                margin >= 0.12
            );

        if (
            uniquelyStrong &&
            best?.product?.id
        ) {
            return {
                status: 'product_resolved',
                product: best.product,
                confidence: bestScore,
                candidates
            };
        }

        return {
            status: 'product_ambiguous',
            product: null,
            confidence: bestScore,
            candidates
        };
    }
}

module.exports =
    PasarPintarProductResolver;
