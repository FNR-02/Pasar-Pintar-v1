class ProductFuzzyMatcher {
    normalize(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    distance(a, b) {
        const x = this.normalize(a);
        const y = this.normalize(b);

        const previous =
            Array.from(
                { length: y.length + 1 },
                (_, i) => i
            );

        for (let i = 1; i <= x.length; i += 1) {
            const current = [i];

            for (let j = 1; j <= y.length; j += 1) {
                const cost =
                    x[i - 1] === y[j - 1]
                        ? 0
                        : 1;

                current[j] =
                    Math.min(
                        current[j - 1] + 1,
                        previous[j] + 1,
                        previous[j - 1] + cost
                    );
            }

            for (
                let j = 0;
                j < current.length;
                j += 1
            ) {
                previous[j] = current[j];
            }
        }

        return previous[y.length];
    }

    tokenMatches(queryToken, productToken) {
        const query = this.normalize(queryToken);
        const product = this.normalize(productToken);

        if (!query || !product) {
            return false;
        }

        if (query === product) {
            return true;
        }

        if (
            query.length >= 4 &&
            product.length >= 4 &&
            (
                product.includes(query) ||
                query.includes(product)
            )
        ) {
            return true;
        }

        const numericSize =
            /^\d+(?:[.,]\d+)?$/;

        if (numericSize.test(query)) {
            const escaped =
                query.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    '\\$&'
                );

            const sizeWithUnit =
                new RegExp(
                    `^${escaped}(?:g|gr|gram|grams|kg|kilogram|ml|l|liter|litre|pcs|pc)$`,
                    'i'
                );

            if (sizeWithUnit.test(product)) {
                return true;
            }
        }

        if (
            query.length < 4 ||
            product.length < 4
        ) {
            return false;
        }

        const distance =
            this.distance(query, product);

        const maxLength =
            Math.max(
                query.length,
                product.length
            );

        if (maxLength <= 5) {
            return distance <= 1;
        }

        if (maxLength <= 8) {
            return distance <= 2;
        }

        return (
            distance <=
            Math.max(
                2,
                Math.floor(maxLength * 0.25)
            )
        );
    }

    matches(searchTerm, productName) {
        const queryTokens =
            this.normalize(searchTerm)
                .split(' ')
                .filter(token => token.length >= 3);

        const productTokens =
            this.normalize(productName)
                .split(' ')
                .filter(Boolean);

        if (!queryTokens.length) {
            return false;
        }

        return queryTokens.every(queryToken =>
            productTokens.some(productToken =>
                this.tokenMatches(
                    queryToken,
                    productToken
                )
            )
        );
    }

    filter(searchTerm, products) {
        if (!Array.isArray(products)) {
            return [];
        }

        return products.filter(product =>
            this.matches(
                searchTerm,
                product?.name
            )
        );
    }
}

module.exports = ProductFuzzyMatcher;
