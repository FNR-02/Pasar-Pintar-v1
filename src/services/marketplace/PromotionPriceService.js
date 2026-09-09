class PromotionPriceService {
    static async getEffectivePrice(
        db,
        productId
    ) {
        const result = await db.query(
            `
            SELECT
                p.id AS product_id,
                retail.amount AS original_price,

                COALESCE(
                    promo.effective_price,
                    retail.amount
                ) AS price,

                promo.promotion_id,
                promo.promotion_name,
                promo.promotion_type,
                promo.discount_value,

                CASE
                    WHEN promo.promotion_id
                        IS NULL
                    THEN FALSE
                    ELSE TRUE
                END AS has_promotion

            FROM tbl_products p

            LEFT JOIN LATERAL (
                SELECT pp.amount
                FROM tbl_product_prices pp
                WHERE pp.product_id = p.id
                  AND pp.price_type = 'RETAIL'
                ORDER BY
                    pp.effective_date DESC
                LIMIT 1
            ) retail ON TRUE

            LEFT JOIN LATERAL (
                SELECT
                    pr.id AS promotion_id,
                    pr.name AS promotion_name,
                    pr.promotion_type,
                    pr.discount_value,

                    CASE
                        WHEN pr.promotion_type =
                            'PERCENT'
                        THEN ROUND(
                            retail.amount *
                            (
                                100 -
                                pr.discount_value
                            ) / 100,
                            2
                        )

                        WHEN pr.promotion_type =
                            'FIXED'
                        THEN GREATEST(
                            retail.amount -
                            pr.discount_value,
                            1
                        )

                        ELSE retail.amount
                    END AS effective_price

                FROM tbl_promotion_products link

                INNER JOIN tbl_promotions pr
                    ON pr.id =
                        link.promotion_id

                INNER JOIN tbl_merchants m
                    ON m.id =
                        pr.merchant_id
                   AND m.id =
                        p.merchant_id
                   AND m.status =
                        'ACTIVE'

                INNER JOIN
                    tbl_merchant_promo_memberships membership
                    ON membership.merchant_id =
                        pr.merchant_id
                   AND membership.status =
                        'APPROVED'

                WHERE link.product_id = p.id

                  AND pr.owner_type =
                    'MERCHANT'

                  AND pr.status IN (
                    'APPROVED',
                    'ACTIVE'
                  )

                  AND pr.promotion_type IN (
                    'PERCENT',
                    'FIXED'
                  )

                  AND pr.starts_at <=
                    CURRENT_TIMESTAMP

                  AND pr.ends_at >
                    CURRENT_TIMESTAMP

                ORDER BY
                    effective_price ASC,
                    pr.approved_at DESC,
                    pr.created_at DESC

                LIMIT 1
            ) promo ON TRUE

            WHERE p.id = $1::uuid

            LIMIT 1
            `,
            [productId]
        );

        if (!result.rowCount) {
            return null;
        }

        return result.rows[0];
    }

    static async decorateRows(
        db,
        rows
    ) {
        if (!Array.isArray(rows) ||
            !rows.length) {
            return rows || [];
        }

        const ids = rows
            .map(row => row.id)
            .filter(Boolean);

        if (!ids.length) {
            return rows;
        }

        const result = await db.query(
            `
            SELECT
                p.id AS product_id,
                retail.amount AS original_price,

                COALESCE(
                    promo.effective_price,
                    retail.amount
                ) AS price,

                promo.promotion_id,
                promo.promotion_name,
                promo.promotion_type,
                promo.discount_value,

                CASE
                    WHEN promo.promotion_id
                        IS NULL
                    THEN FALSE
                    ELSE TRUE
                END AS has_promotion

            FROM tbl_products p

            LEFT JOIN LATERAL (
                SELECT pp.amount
                FROM tbl_product_prices pp
                WHERE pp.product_id = p.id
                  AND pp.price_type = 'RETAIL'
                ORDER BY
                    pp.effective_date DESC
                LIMIT 1
            ) retail ON TRUE

            LEFT JOIN LATERAL (
                SELECT
                    pr.id AS promotion_id,
                    pr.name AS promotion_name,
                    pr.promotion_type,
                    pr.discount_value,

                    CASE
                        WHEN pr.promotion_type =
                            'PERCENT'
                        THEN ROUND(
                            retail.amount *
                            (
                                100 -
                                pr.discount_value
                            ) / 100,
                            2
                        )

                        WHEN pr.promotion_type =
                            'FIXED'
                        THEN GREATEST(
                            retail.amount -
                            pr.discount_value,
                            1
                        )

                        ELSE retail.amount
                    END AS effective_price

                FROM tbl_promotion_products link

                INNER JOIN tbl_promotions pr
                    ON pr.id =
                        link.promotion_id

                INNER JOIN tbl_merchants m
                    ON m.id =
                        pr.merchant_id
                   AND m.id =
                        p.merchant_id
                   AND m.status =
                        'ACTIVE'

                INNER JOIN
                    tbl_merchant_promo_memberships membership
                    ON membership.merchant_id =
                        pr.merchant_id
                   AND membership.status =
                        'APPROVED'

                WHERE link.product_id = p.id

                  AND pr.owner_type =
                    'MERCHANT'

                  AND pr.status IN (
                    'APPROVED',
                    'ACTIVE'
                  )

                  AND pr.promotion_type IN (
                    'PERCENT',
                    'FIXED'
                  )

                  AND pr.starts_at <=
                    CURRENT_TIMESTAMP

                  AND pr.ends_at >
                    CURRENT_TIMESTAMP

                ORDER BY
                    effective_price ASC,
                    pr.approved_at DESC,
                    pr.created_at DESC

                LIMIT 1
            ) promo ON TRUE

            WHERE p.id =
                ANY($1::uuid[])
            `,
            [ids]
        );

        const prices =
            new Map(
                result.rows.map(row => [
                    row.product_id,
                    row
                ])
            );

        return rows.map(row => {
            const pricing =
                prices.get(row.id);

            if (!pricing) {
                return row;
            }

            return {
                ...row,

                original_price:
                    Number(
                        pricing.original_price ||
                        row.price ||
                        0
                    ),

                price:
                    Number(
                        pricing.price ||
                        pricing.original_price ||
                        row.price ||
                        0
                    ),

                has_promotion:
                    Boolean(
                        pricing.has_promotion
                    ),

                promotion_id:
                    pricing.promotion_id ||
                    null,

                promotion_name:
                    pricing.promotion_name ||
                    null,

                promotion_type:
                    pricing.promotion_type ||
                    null,

                discount_value:
                    pricing.discount_value ===
                        null ||
                    pricing.discount_value ===
                        undefined
                        ? null
                        : Number(
                            pricing.discount_value
                        )
            };
        });
    }
}

module.exports =
    PromotionPriceService;
