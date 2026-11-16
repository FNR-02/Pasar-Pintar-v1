-- Inventory ledger integrity v1
-- Additive only. Do not rewrite historical movements.

ALTER TABLE tbl_inventory_movements
ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS
    tbl_inventory_movements_opening_adjustment_unique
ON tbl_inventory_movements
    (reference_doc, product_id)
WHERE movement_type IN (
    'OPENING_STOCK',
    'ADJUSTMENT_IN',
    'ADJUSTMENT_OUT'
);
