ALTER TABLE tbl_products
ADD COLUMN IF NOT EXISTS import_photo_filename TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS
idx_products_merchant_pending_photo_filename_unique
ON tbl_products (
    merchant_id,
    LOWER(import_photo_filename)
)
WHERE import_photo_filename IS NOT NULL
  AND BTRIM(import_photo_filename) <> '';
