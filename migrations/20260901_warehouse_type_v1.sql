BEGIN;

ALTER TABLE tbl_warehouses
ADD COLUMN IF NOT EXISTS warehouse_type varchar(40);

-- Gudang M Acong adalah gudang platform Pasar Pintar,
-- bukan gudang milik merchant.
UPDATE tbl_warehouses
SET merchant_id = NULL
WHERE id = '286f0451-675d-421a-a881-61d3d50930aa'
  AND warehouse_name = 'Gudang M Acong';

UPDATE tbl_warehouses
SET warehouse_type = CASE
    WHEN id = '286f0451-675d-421a-a881-61d3d50930aa'
         AND warehouse_name = 'Gudang M Acong'
        THEN 'PASAR_PINTAR_HUB'
    ELSE 'MERCHANT_STORE'
END
WHERE warehouse_type IS NULL;

UPDATE tbl_warehouses
SET warehouse_type = 'PASAR_PINTAR_HUB'
WHERE id = '286f0451-675d-421a-a881-61d3d50930aa'
  AND warehouse_name = 'Gudang M Acong';

ALTER TABLE tbl_warehouses
ALTER COLUMN warehouse_type
SET DEFAULT 'MERCHANT_STORE';

ALTER TABLE tbl_warehouses
ALTER COLUMN warehouse_type
SET NOT NULL;

ALTER TABLE tbl_warehouses
DROP CONSTRAINT IF EXISTS tbl_warehouses_type_check;

ALTER TABLE tbl_warehouses
ADD CONSTRAINT tbl_warehouses_type_check
CHECK (
    warehouse_type IN (
        'MERCHANT_STORE',
        'PASAR_PINTAR_HUB'
    )
);

CREATE INDEX IF NOT EXISTS
idx_tbl_warehouses_type
ON tbl_warehouses(warehouse_type);

COMMIT;
