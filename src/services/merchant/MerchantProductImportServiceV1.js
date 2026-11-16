const CommerceKernel =
    require('../../kernel/EventKernel');

function normalized(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

async function resolveLeafCategories(
    client,
    rows
) {
    const result = await client.query(
        `SELECT c.id, c.name
         FROM tbl_product_categories c
         WHERE NOT EXISTS (
             SELECT 1
             FROM tbl_product_categories child
             WHERE child.parent_id = c.id
         )`
    );

    const map = new Map();

    for (const category of result.rows) {
        const key = normalized(category.name);

        if (!map.has(key)) {
            map.set(key, []);
        }

        map.get(key).push(category);
    }

    const resolved = new Map();

    for (const item of rows) {
        const matches =
            map.get(normalized(item.category)) || [];

        if (matches.length !== 1) {
            throw new Error(
                `Kategori import tidak valid: ${item.category}`
            );
        }

        resolved.set(
            item.rowNumber,
            matches[0].id
        );
    }

    return resolved;
}

module.exports = {
    normalized,
    resolveLeafCategories,
    resolveDefaultWarehouse,
    insertBaseProducts,
    attachParentVariants,
    executeImport,
    CommerceKernel
};

async function resolveDefaultWarehouse(
    client,
    merchant
) {
    await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        [String(merchant.id)]
    );

    const safeStoreName =
        String(merchant.store_name || 'Merchant').trim() ||
        'Merchant';

    const warehouseName =
        `Stok Toko - ${safeStoreName}`;

    let result = await client.query(
        `SELECT id
         FROM tbl_warehouses
         WHERE merchant_id = $1
           AND warehouse_name = $2
           AND warehouse_type = 'MERCHANT_STORE'
         ORDER BY created_at ASC
         LIMIT 1`,
        [
            merchant.id,
            warehouseName
        ]
    );

    if (result.rowCount === 0) {
        result = await client.query(
            `INSERT INTO tbl_warehouses
             (
                warehouse_name,
                location,
                merchant_id,
                warehouse_type
             )
             VALUES ($1, $2, $3, 'MERCHANT_STORE')
             RETURNING id`,
            [
                warehouseName,
                merchant.address ||
                    'Lokasi usaha merchant',
                merchant.id
            ]
        );
    }

    return result.rows[0].id;
}

async function insertBaseProducts(
    client,
    merchantId,
    warehouseId,
    rows,
    categoryIds,
    createdBy
) {
    const inserted = [];

    for (const item of rows) {
        const categoryId =
            categoryIds.get(item.rowNumber);

        const productResult =
            await client.query(
                `INSERT INTO tbl_products
                 (
                    merchant_id,
                    category_id,
                    sku,
                    name,
                    description,
                    selling_unit,
                    pack_size_value,
                    pack_size_unit,
                    import_photo_filename,
                    parent_product_id,
                    variant_label,
                    customer_visible
                 )
                 VALUES (
                    $1,$2,$3,$4,$5,
                    $6,$7,$8,$9,
                    NULL,NULL,FALSE
                 )
                 RETURNING *`,
                [
                    merchantId,
                    categoryId,
                    item.sku,
                    item.name,
                    item.description || null,
                    item.sellingUnit,
                    item.packSizeValue,
                    item.packSizeUnit || null,
                    item.photoFilename || null
                ]
            );

        const product =
            productResult.rows[0];

        await client.query(
            `INSERT INTO tbl_product_prices
             (
                product_id,
                price_type,
                amount
             )
             VALUES ($1, 'RETAIL', $2)`,
            [
                product.id,
                item.price
            ]
        );

        await client.query(
            `INSERT INTO tbl_inventory
             (
                warehouse_id,
                product_id,
                quantity_on_hand,
                min_stock_level
             )
             VALUES ($1, $2, $3, $4)`,
            [
                warehouseId,
                product.id,
                item.stock,
                item.minStock
            ]
        );

        if (item.stock > 0) {
            await client.query(
                `INSERT INTO tbl_inventory_movements
                 (
                    product_id,
                    warehouse_id,
                    movement_type,
                    quantity,
                    reference_doc,
                    created_by,
                    notes
                 )
                 VALUES ($1, $2, 'OPENING_STOCK', $3, $4, $5, $6)`,
                [
                    product.id,
                    warehouseId,
                    item.stock,
                    `IMPORT-${product.id}`,
                    createdBy,
                    'Stok awal dari import produk'
                ]
            );
        }

        inserted.push({
            source: item,
            product
        });
    }

    return inserted;
}

async function attachParentVariants(
    client,
    merchantId,
    inserted
) {
    const importedSkuMap =
        new Map();

    for (const entry of inserted) {
        importedSkuMap.set(
            normalized(entry.source.sku),
            entry.product.id
        );
    }

    for (const entry of inserted) {
        const parentSku =
            String(
                entry.source.parentSku || ''
            ).trim();

        const variantLabel =
            String(
                entry.source.variantLabel || ''
            ).trim();

        if (!parentSku) {
            continue;
        }

        let parentId =
            importedSkuMap.get(
                normalized(parentSku)
            ) || null;

        if (!parentId) {
            const parentResult =
                await client.query(
                    `SELECT id
                     FROM tbl_products
                     WHERE merchant_id = $1
                       AND LOWER(TRIM(sku)) =
                           LOWER(TRIM($2))
                       AND status = 'ACTIVE'
                     LIMIT 1`,
                    [
                        merchantId,
                        parentSku
                    ]
                );

            if (parentResult.rowCount === 0) {
                throw new Error(
                    `Produk induk tidak ditemukan: ${parentSku}`
                );
            }

            parentId =
                parentResult.rows[0].id;
        }

        if (
            String(parentId) ===
            String(entry.product.id)
        ) {
            throw new Error(
                `Produk tidak boleh menjadi induk dirinya sendiri: ${entry.source.sku}`
            );
        }

        await client.query(
            `UPDATE tbl_products
             SET
                parent_product_id = $1,
                variant_label = $2,
                updated_at = NOW()
             WHERE id = $3
               AND merchant_id = $4`,
            [
                parentId,
                variantLabel || null,
                entry.product.id,
                merchantId
            ]
        );

        entry.product.parent_product_id =
            parentId;

        entry.product.variant_label =
            variantLabel || null;
    }

    return inserted;
}

async function executeImport(
    pool,
    userId,
    rows
) {
    const merchantResult =
        await pool.query(
            `SELECT
                id,
                store_name,
                address
             FROM tbl_merchants
             WHERE user_id = $1
               AND status = 'ACTIVE'
             LIMIT 1`,
            [userId]
        );

    if (merchantResult.rowCount === 0) {
        throw new Error(
            'Merchant aktif tidak ditemukan'
        );
    }

    const merchant =
        merchantResult.rows[0];

    const client =
        await pool.connect();

    try {
        await client.query('BEGIN');

        const categoryIds =
            await resolveLeafCategories(
                client,
                rows
            );

        const warehouseId =
            await resolveDefaultWarehouse(
                client,
                merchant
            );

        const inserted =
            await insertBaseProducts(
                client,
                merchant.id,
                warehouseId,
                rows,
                categoryIds,
                userId
            );

        await attachParentVariants(
            client,
            merchant.id,
            inserted
        );

        await client.query('COMMIT');

        setImmediate(() => {
            for (const entry of inserted) {
                CommerceKernel.emitEvent(
                    'PRODUCT_CREATED',
                    'PRODUCT',
                    entry.product.id,
                    entry.product
                );
            }
        });

        return {
            merchant,
            warehouseId,
            inserted
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
