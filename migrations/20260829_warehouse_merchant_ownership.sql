BEGIN;

ALTER TABLE tbl_warehouses
    ADD COLUMN IF NOT EXISTS merchant_id UUID;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM tbl_inventory i
        JOIN tbl_products p
          ON p.id = i.product_id
        GROUP BY i.warehouse_id
        HAVING COUNT(DISTINCT p.merchant_id) > 1
    ) THEN
        RAISE EXCEPTION
            'Warehouse ownership migration failed: warehouse digunakan lebih dari satu merchant';
    END IF;
END
$$;

UPDATE tbl_warehouses w
SET merchant_id = x.merchant_id
FROM (
    SELECT
        i.warehouse_id,
        MIN(p.merchant_id::text)::uuid AS merchant_id
    FROM tbl_inventory i
    JOIN tbl_products p
      ON p.id = i.product_id
    GROUP BY i.warehouse_id
    HAVING COUNT(DISTINCT p.merchant_id) = 1
) x
WHERE x.warehouse_id = w.id
  AND w.merchant_id IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'tbl_warehouses_merchant_id_fkey'
          AND conrelid =
            'tbl_warehouses'::regclass
    ) THEN
        ALTER TABLE tbl_warehouses
            ADD CONSTRAINT
                tbl_warehouses_merchant_id_fkey
            FOREIGN KEY (merchant_id)
            REFERENCES tbl_merchants(id);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS
    idx_tbl_warehouses_merchant_id
ON tbl_warehouses(merchant_id);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM tbl_inventory i
        JOIN tbl_products p
          ON p.id = i.product_id
        JOIN tbl_warehouses w
          ON w.id = i.warehouse_id
        WHERE w.merchant_id IS NULL
           OR w.merchant_id <> p.merchant_id
    ) THEN
        RAISE EXCEPTION
            'Warehouse ownership validation failed';
    END IF;
END
$$;

COMMIT;
