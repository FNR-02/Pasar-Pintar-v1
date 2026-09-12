class PasarPintarSemanticCatalogService {
    constructor(pool) {
        this.pool = pool;
    }

    normalize(value) {
        return String(value || '')
            .trim()
            .toLowerCase();
    }

    expandCategoryQuery(value) {
        const q = this.normalize(value);

        const aliases = {
            'makanan beku': 'frozen food',
            'makanan frozen': 'frozen food',
            'frozen': 'frozen food',
            'cemilan': 'jajanan',
            'camilan': 'jajanan',
            'snack': 'jajanan',
            'bakso': 'baso',
            'mi': 'mie'
        };

        return aliases[q] || q;
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

    async search(request = {}) {
        let productQuery =
            this.normalize(request.productQuery);

        let categoryQuery =
            this.expandCategoryQuery(
                request.categoryQuery
            );

        /*
         * Gemini may occasionally place a category phrase in
         * productQuery instead of categoryQuery.
         *
         * Normalize only explicit category-like aliases here.
         * Product names such as "dumpling" remain product queries.
         */
        if (
            productQuery &&
            !categoryQuery
        ) {
            const categoryLikeAliases = {
                'frozen food': 'frozen food',
                'makanan beku': 'frozen food',
                'makanan frozen': 'frozen food',
                'frozen': 'frozen food',

                'jajanan': 'jajanan',
                'jajanan dan cemilan': 'jajanan',
                'jajanan & cemilan': 'jajanan',
                'cemilan': 'jajanan',
                'camilan': 'jajanan',
                'snack': 'jajanan'
            };

            const promotedCategory =
                categoryLikeAliases[
                    productQuery
                ];

            if (promotedCategory) {
                categoryQuery =
                    promotedCategory;

                productQuery = '';
            }
        }

        const parseBudget = value => {
            if (
                value === null ||
                value === undefined ||
                String(value).trim() === ''
            ) {
                return null;
            }

            const parsed =
                Number(value);

            return Number.isFinite(parsed)
                ? parsed
                : null;
        };

        const budgetMin =
            parseBudget(request.budgetMin);

        const budgetMax =
            parseBudget(request.budgetMax);

        const sortPreference =
            String(
                request.sortPreference || ''
            ).toUpperCase();

        const params = [
            productQuery || null,
            categoryQuery || null,
            budgetMin,
            budgetMax
        ];

        const result =
            await this.pool.query(
                `
                SELECT
                    p.id,
                    p.sku,
                    p.name,
                    p.selling_unit,

                    category.name
                        AS category_name,

                    parent_category.name
                        AS parent_category_name,

                    COALESCE(
                        price.amount,
                        0
                    )::numeric AS price,

                    COALESCE(
                        inv.stock,
                        0
                    )::int AS stock

                FROM tbl_products p

                INNER JOIN tbl_merchants m
                    ON m.id = p.merchant_id
                   AND m.status = 'ACTIVE'

                LEFT JOIN
                    tbl_product_categories category
                    ON category.id =
                        p.category_id

                LEFT JOIN
                    tbl_product_categories
                        parent_category
                    ON parent_category.id =
                        category.parent_id

                LEFT JOIN LATERAL (
                    SELECT pp.amount
                    FROM tbl_product_prices pp
                    WHERE pp.product_id = p.id
                      AND pp.price_type =
                          'RETAIL'
                    ORDER BY
                        pp.effective_date DESC
                    LIMIT 1
                ) price ON TRUE

                LEFT JOIN LATERAL (
                    SELECT
                        SUM(
                            i.quantity_on_hand
                        )::int AS stock
                    FROM tbl_inventory i
                    WHERE i.product_id = p.id
                ) inv ON TRUE

                WHERE
                    p.status = 'ACTIVE'
                    AND p.customer_visible =
                        TRUE

                    AND (
                        $1::text IS NULL
                        OR NOT EXISTS (
                            SELECT 1
                            FROM unnest(
                                regexp_split_to_array(
                                    trim($1),
                                    '\\s+'
                                )
                            ) AS query_token(token)
                            WHERE
                                query_token.token <> ''
                                AND p.name NOT ILIKE
                                    '%' ||
                                    CASE
                                        /*
                                         * Toleransi generik untuk plural
                                         * sederhana seperti:
                                         * dumplings -> dumpling.
                                         *
                                         * Ini bukan kamus produk.
                                         */
                                        WHEN
                                            length(
                                                query_token.token
                                            ) > 4
                                            AND right(
                                                query_token.token,
                                                1
                                            ) = 's'
                                        THEN left(
                                            query_token.token,
                                            -1
                                        )
                                        ELSE query_token.token
                                    END ||
                                    '%'
                        )
                    )

                    AND (
                        $2::text IS NULL
                        OR category.name ILIKE
                            '%' || $2 || '%'
                        OR parent_category.name
                            ILIKE
                            '%' || $2 || '%'
                        OR p.name ILIKE
                            '%' || $2 || '%'
                    )

                    AND (
                        $3::numeric IS NULL
                        OR COALESCE(
                            price.amount,
                            0
                        ) >= $3
                    )

                    AND (
                        $4::numeric IS NULL
                        OR COALESCE(
                            price.amount,
                            0
                        ) <= $4
                    )

                    AND COALESCE(
                        inv.stock,
                        0
                    ) > 0

                    AND COALESCE(
                        price.amount,
                        0
                    ) > 0

                ORDER BY

                    CASE
                        WHEN $2::text IS NOT NULL
                         AND (
                            LOWER(
                                parent_category.name
                            ) =
                            LOWER($2)
                            OR LOWER(
                                category.name
                            ) =
                            LOWER($2)
                         )
                        THEN 0
                        ELSE 1
                    END,

                    CASE
                        WHEN $1::text IS NOT NULL
                         AND p.name ILIKE
                            '%' || $1 || '%'
                        THEN 0
                        ELSE 1
                    END,

                    CASE
                        WHEN $5 = 'CHEAPEST'
                        THEN COALESCE(
                            price.amount,
                            0
                        )
                    END ASC,

                    CASE
                        WHEN $5 = 'MOST_EXPENSIVE'
                        THEN COALESCE(
                            price.amount,
                            0
                        )
                    END DESC,

                    p.name ASC

                LIMIT 8
                `,
                [
                    ...params,
                    sortPreference
                ]
            );

        const products =
            result.rows.map(row => ({
                id: row.id,
                sku: row.sku,
                name: row.name,
                category:
                    row.category_name,
                parentCategory:
                    row.parent_category_name,
                sellingUnit:
                    row.selling_unit,
                price:
                    Number(row.price),
                stock:
                    Number(row.stock)
            }));

        if (products.length === 0) {
            return {
                status: 'not_found',
                products: [],
                responseText:
                    'Belum ketemu produk yang cocok dengan kebutuhan kak. Bisa sebut jenis produk atau kisaran harganya?'
            };
        }

        const lines =
            products.map(
                (product, index) =>
                    `${index + 1}. ` +
                    `${product.name} — ` +
                    `${this.rupiah(
                        product.price
                    )} — ` +
                    `stok ${product.stock}`
            );

        let intro =
            'Ada kak. Ini beberapa yang cocok:';

        if (
            categoryQuery &&
            sortPreference === 'CHEAPEST'
        ) {
            intro =
                `Ada kak. Ini pilihan ${categoryQuery} ` +
                'mulai dari yang paling murah:';
        } else if (categoryQuery) {
            intro =
                `Ada kak. Ini beberapa pilihan ${categoryQuery}:`;
        } else if (
            sortPreference === 'CHEAPEST'
        ) {
            intro =
                'Ada kak. Ini beberapa pilihan mulai dari yang paling murah:';
        }

        return {
            status: 'semantic_catalog',
            products,
            responseText:
                `${intro}\n\n` +
                lines.join('\n') +
                '\n\nKalau ada yang menarik, sebut nama atau nomornya ya kak.'
        };
    }
}

module.exports =
    PasarPintarSemanticCatalogService;
