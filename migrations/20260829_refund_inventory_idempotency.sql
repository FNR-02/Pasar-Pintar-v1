CREATE UNIQUE INDEX IF NOT EXISTS
tbl_inventory_movements_refund_return_unique
ON tbl_inventory_movements (
    reference_doc,
    product_id,
    movement_type
)
WHERE movement_type = 'REFUND_RETURN';
