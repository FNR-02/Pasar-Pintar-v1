BEGIN;

ALTER TABLE tbl_b2b_orders
ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

ALTER TABLE tbl_b2b_orders
ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

COMMIT;
