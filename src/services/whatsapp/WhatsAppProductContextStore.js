class WhatsAppProductContextStore {
    constructor(pool) {
        this.pool = pool;
    }

    async saveSelectionContext({
        customerId,
        products,
        sourceMessageId = null
    }) {
        if (
            !customerId ||
            !Array.isArray(products) ||
            products.length === 0
        ) {
            const err = new Error(
                'Konteks produk WhatsApp tidak lengkap'
            );
            err.code = 'INVALID_PRODUCT_CONTEXT';
            throw err;
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            await client.query(
                `
                UPDATE tbl_whatsapp_product_contexts
                SET
                    status = 'EXPIRED',
                    updated_at = CURRENT_TIMESTAMP
                WHERE customer_id = $1
                  AND status = 'ACTIVE'
                `,
                [customerId]
            );

            const result =
                await client.query(
                    `
                    INSERT INTO tbl_whatsapp_product_contexts (
                        customer_id,
                        context_type,
                        context_payload,
                        source_message_id
                    )
                    VALUES (
                        $1,
                        'PRODUCT_IMAGE_SELECTION',
                        $2::jsonb,
                        $3
                    )
                    RETURNING
                        id,
                        customer_id,
                        context_type,
                        context_payload,
                        source_message_id,
                        status,
                        created_at,
                        updated_at,
                        expires_at
                    `,
                    [
                        customerId,
                        JSON.stringify({
                            products
                        }),
                        sourceMessageId
                    ]
                );

            await client.query('COMMIT');

            return {
                status: 'stored',
                context: result.rows[0]
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async saveMultiImageSelectionContext({
        customerId,
        products,
        resolvedProducts = [],
        sourceMessageId = null
    }) {
        if (
            !customerId ||
            !Array.isArray(products) ||
            products.length === 0 ||
            !Array.isArray(resolvedProducts)
        ) {
            const err = new Error(
                'Konteks multi gambar WhatsApp tidak lengkap'
            );
            err.code = 'INVALID_PRODUCT_CONTEXT';
            throw err;
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            await client.query(
                `
                UPDATE tbl_whatsapp_product_contexts
                SET
                    status = 'EXPIRED',
                    updated_at = CURRENT_TIMESTAMP
                WHERE customer_id = $1
                  AND status = 'ACTIVE'
                `,
                [customerId]
            );

            const result =
                await client.query(
                    `
                    INSERT INTO tbl_whatsapp_product_contexts (
                        customer_id,
                        context_type,
                        context_payload,
                        source_message_id
                    )
                    VALUES (
                        $1,
                        'PRODUCT_MULTI_IMAGE_SELECTION',
                        $2::jsonb,
                        $3
                    )
                    RETURNING *
                    `,
                    [
                        customerId,
                        JSON.stringify({
                            products,
                            resolvedProducts
                        }),
                        sourceMessageId
                    ]
                );

            await client.query('COMMIT');

            return {
                status: 'stored',
                context: result.rows[0]
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async saveOrderSelectionContext({
        customerId,
        products,
        quantity = 1,
        sourceMessageId = null
    }) {
        if (
            !customerId ||
            !Array.isArray(products) ||
            products.length === 0 ||
            !Number.isInteger(Number(quantity)) ||
            Number(quantity) < 1 ||
            Number(quantity) > 100
        ) {
            const err = new Error(
                'Konteks pilihan pesanan WhatsApp tidak lengkap'
            );
            err.code = 'INVALID_PRODUCT_CONTEXT';
            throw err;
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            await client.query(
                `
                UPDATE tbl_whatsapp_product_contexts
                SET
                    status = 'EXPIRED',
                    updated_at = CURRENT_TIMESTAMP
                WHERE customer_id = $1
                  AND status = 'ACTIVE'
                `,
                [customerId]
            );

            const result =
                await client.query(
                    `
                    INSERT INTO tbl_whatsapp_product_contexts (
                        customer_id,
                        context_type,
                        context_payload,
                        source_message_id
                    )
                    VALUES (
                        $1,
                        'PRODUCT_ORDER_SELECTION',
                        $2::jsonb,
                        $3
                    )
                    RETURNING
                        id,
                        customer_id,
                        context_type,
                        context_payload,
                        source_message_id,
                        status,
                        created_at,
                        updated_at,
                        expires_at
                    `,
                    [
                        customerId,
                        JSON.stringify({
                            products,
                            quantity:
                                Number(quantity)
                        }),
                        sourceMessageId
                    ]
                );

            await client.query('COMMIT');

            return {
                status: 'stored',
                context: result.rows[0]
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async saveReferenceContext({
        customerId,
        products,
        alternatives = [],
        sourceMessageId = null
    }) {
        if (
            !customerId ||
            !Array.isArray(products) ||
            products.length === 0
        ) {
            const err = new Error(
                'Konteks referensi produk WhatsApp tidak lengkap'
            );
            err.code = 'INVALID_PRODUCT_CONTEXT';
            throw err;
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            await client.query(
                `
                UPDATE tbl_whatsapp_product_contexts
                SET
                    status = 'EXPIRED',
                    updated_at = CURRENT_TIMESTAMP
                WHERE customer_id = $1
                  AND status = 'ACTIVE'
                `,
                [customerId]
            );

            const result =
                await client.query(
                    `
                    INSERT INTO tbl_whatsapp_product_contexts (
                        customer_id,
                        context_type,
                        context_payload,
                        source_message_id
                    )
                    VALUES (
                        $1,
                        'PRODUCT_REFERENCE',
                        $2::jsonb,
                        $3
                    )
                    RETURNING
                        id,
                        customer_id,
                        context_type,
                        context_payload,
                        source_message_id,
                        status,
                        created_at,
                        updated_at,
                        expires_at
                    `,
                    [
                        customerId,
                        JSON.stringify({
                            products,
                            alternatives:
                                Array.isArray(alternatives)
                                    ? alternatives
                                    : []
                        }),
                        sourceMessageId
                    ]
                );

            await client.query('COMMIT');

            return {
                status: 'stored',
                context: result.rows[0]
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async saveDraftAlternativesContext({
        customerId,
        products,
        sourceMessageId = null
    }) {
        if (
            !customerId ||
            !Array.isArray(products) ||
            products.length < 2
        ) {
            const err = new Error(
                'Alternatif produk draft WhatsApp tidak lengkap'
            );
            err.code =
                'INVALID_PRODUCT_CONTEXT';
            throw err;
        }

        const uniqueProducts =
            Array.from(
                new Map(
                    products
                        .filter(product =>
                            product?.id &&
                            product?.name
                        )
                        .map(product => [
                            product.id,
                            {
                                id: product.id,
                                name: product.name
                            }
                        ])
                ).values()
            );

        if (uniqueProducts.length < 2) {
            const err = new Error(
                'Alternatif produk draft WhatsApp tidak cukup'
            );
            err.code =
                'INVALID_PRODUCT_CONTEXT';
            throw err;
        }

        const client =
            await this.pool.connect();

        try {
            await client.query('BEGIN');

            await client.query(
                `
                UPDATE tbl_whatsapp_product_contexts
                SET
                    status = 'EXPIRED',
                    updated_at = CURRENT_TIMESTAMP
                WHERE customer_id = $1
                  AND status = 'ACTIVE'
                `,
                [customerId]
            );

            const result =
                await client.query(
                    `
                    INSERT INTO tbl_whatsapp_product_contexts (
                        customer_id,
                        context_type,
                        context_payload,
                        source_message_id
                    )
                    VALUES (
                        $1,
                        'DRAFT_PRODUCT_ALTERNATIVES',
                        $2::jsonb,
                        $3
                    )
                    RETURNING
                        id,
                        customer_id,
                        context_type,
                        context_payload,
                        source_message_id,
                        status,
                        created_at,
                        updated_at,
                        expires_at
                    `,
                    [
                        customerId,
                        JSON.stringify({
                            products:
                                uniqueProducts
                        }),
                        sourceMessageId
                    ]
                );

            await client.query('COMMIT');

            return {
                status: 'stored',
                context: result.rows[0]
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async getActive(customerId) {
        if (!customerId) {
            return null;
        }

        const result =
            await this.pool.query(
                `
                SELECT
                    id,
                    customer_id,
                    context_type,
                    context_payload,
                    source_message_id,
                    status,
                    created_at,
                    updated_at,
                    expires_at
                FROM tbl_whatsapp_product_contexts
                WHERE customer_id = $1
                  AND status = 'ACTIVE'
                  AND expires_at > CURRENT_TIMESTAMP
                ORDER BY created_at DESC
                LIMIT 1
                `,
                [customerId]
            );

        return result.rowCount > 0
            ? result.rows[0]
            : null;
    }

    async clear(customerId) {
        if (!customerId) {
            return {
                status: 'ignored'
            };
        }

        const result =
            await this.pool.query(
                `
                UPDATE tbl_whatsapp_product_contexts
                SET
                    status = 'COMPLETED',
                    updated_at = CURRENT_TIMESTAMP
                WHERE customer_id = $1
                  AND status = 'ACTIVE'
                `,
                [customerId]
            );

        return {
            status: 'cleared',
            count: result.rowCount
        };
    }
}

module.exports =
    WhatsAppProductContextStore;
