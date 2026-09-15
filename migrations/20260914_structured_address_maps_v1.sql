ALTER TABLE tbl_customers
    ADD COLUMN IF NOT EXISTS default_address_line TEXT,
    ADD COLUMN IF NOT EXISTS default_village VARCHAR(120),
    ADD COLUMN IF NOT EXISTS default_district VARCHAR(120),
    ADD COLUMN IF NOT EXISTS default_city VARCHAR(120),
    ADD COLUMN IF NOT EXISTS default_province VARCHAR(120),
    ADD COLUMN IF NOT EXISTS default_postal_code VARCHAR(12),
    ADD COLUMN IF NOT EXISTS default_landmark TEXT,
    ADD COLUMN IF NOT EXISTS default_place_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS default_latitude NUMERIC(9,6),
    ADD COLUMN IF NOT EXISTS default_longitude NUMERIC(9,6);

ALTER TABLE tbl_merchants
    ADD COLUMN IF NOT EXISTS address_line TEXT,
    ADD COLUMN IF NOT EXISTS village VARCHAR(120),
    ADD COLUMN IF NOT EXISTS district VARCHAR(120),
    ADD COLUMN IF NOT EXISTS city VARCHAR(120),
    ADD COLUMN IF NOT EXISTS province VARCHAR(120),
    ADD COLUMN IF NOT EXISTS postal_code VARCHAR(12),
    ADD COLUMN IF NOT EXISTS landmark TEXT,
    ADD COLUMN IF NOT EXISTS place_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS latitude NUMERIC(9,6),
    ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6);

ALTER TABLE tbl_market_orders
    ADD COLUMN IF NOT EXISTS shipping_address_line TEXT,
    ADD COLUMN IF NOT EXISTS shipping_village VARCHAR(120),
    ADD COLUMN IF NOT EXISTS shipping_district VARCHAR(120),
    ADD COLUMN IF NOT EXISTS shipping_city VARCHAR(120),
    ADD COLUMN IF NOT EXISTS shipping_province VARCHAR(120),
    ADD COLUMN IF NOT EXISTS shipping_postal_code VARCHAR(12),
    ADD COLUMN IF NOT EXISTS shipping_landmark TEXT,
    ADD COLUMN IF NOT EXISTS shipping_place_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS shipping_latitude NUMERIC(9,6),
    ADD COLUMN IF NOT EXISTS shipping_longitude NUMERIC(9,6);
