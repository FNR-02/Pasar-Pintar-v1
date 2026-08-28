BEGIN;

ALTER TABLE tbl_products
    ALTER COLUMN customer_visible SET DEFAULT FALSE;

COMMIT;
