BEGIN;

ALTER TABLE tbl_merchants
    ADD COLUMN IF NOT EXISTS logo_url TEXT;

ALTER TABLE tbl_merchants
    ADD COLUMN IF NOT EXISTS banner_url TEXT;

ALTER TABLE tbl_merchants
    ADD COLUMN IF NOT EXISTS description TEXT;

COMMIT;
