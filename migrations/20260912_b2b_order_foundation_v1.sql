BEGIN;

-- ============================================================
-- PASAR PINTAR B2B ORDER FOUNDATION V1
--
-- Jalur:
-- seller merchant -> buyer merchant
--
-- V1:
-- - CASH only
-- - belum melakukan stock transfer
-- - buyer product dapat dibuat/dipetakan saat receiving
-- ============================================================

CREATE TABLE IF NOT EXISTS tbl_b2b_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    seller_merchant_id uuid NOT NULL
        REFERENCES tbl_merchants(id),

    buyer_merchant_id uuid NOT NULL
        REFERENCES tbl_merchants(id),

    source_warehouse_id uuid NOT NULL
        REFERENCES tbl_warehouses(id),

    destination_warehouse_id uuid NOT NULL
        REFERENCES tbl_warehouses(id),

    status varchar NOT NULL DEFAULT 'DRAFT',

    payment_mode varchar NOT NULL DEFAULT 'CASH',

    total_amount numeric(18,2) NOT NULL DEFAULT 0,

    notes text,

    created_by uuid
        REFERENCES tbl_users(id),

    submitted_at timestamptz,
    approved_at timestamptz,
    approved_by uuid
        REFERENCES tbl_users(id),

    received_at timestamptz,
    received_by uuid
        REFERENCES tbl_users(id),

    rejected_at timestamptz,
    rejected_by uuid
        REFERENCES tbl_users(id),

    cancelled_at timestamptz,
    cancelled_by uuid
        REFERENCES tbl_users(id),

    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT tbl_b2b_orders_merchants_different_check
        CHECK (seller_merchant_id <> buyer_merchant_id),

    CONSTRAINT tbl_b2b_orders_status_check
        CHECK (
            status IN (
                'DRAFT',
                'SUBMITTED',
                'APPROVED',
                'REJECTED',
                'RECEIVED',
                'CANCELLED'
            )
        ),

    CONSTRAINT tbl_b2b_orders_payment_mode_check
        CHECK (payment_mode = 'CASH'),

    CONSTRAINT tbl_b2b_orders_total_amount_check
        CHECK (total_amount >= 0)
);

CREATE TABLE IF NOT EXISTS tbl_b2b_order_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    b2b_order_id uuid NOT NULL
        REFERENCES tbl_b2b_orders(id)
        ON DELETE CASCADE,

    source_product_id uuid NOT NULL
        REFERENCES tbl_products(id),

    buyer_product_id uuid
        REFERENCES tbl_products(id),

    quantity integer NOT NULL,

    unit_price numeric(18,2) NOT NULL,

    line_total numeric(18,2) NOT NULL,

    selling_unit_snapshot varchar NOT NULL,

    pack_size_value_snapshot numeric,

    pack_size_unit_snapshot varchar,

    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT tbl_b2b_order_items_quantity_check
        CHECK (quantity > 0),

    CONSTRAINT tbl_b2b_order_items_unit_price_check
        CHECK (unit_price >= 0),

    CONSTRAINT tbl_b2b_order_items_line_total_check
        CHECK (line_total >= 0),

    CONSTRAINT tbl_b2b_order_items_order_product_unique
        UNIQUE (b2b_order_id, source_product_id)
);

CREATE TABLE IF NOT EXISTS tbl_b2b_product_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    seller_merchant_id uuid NOT NULL
        REFERENCES tbl_merchants(id),

    buyer_merchant_id uuid NOT NULL
        REFERENCES tbl_merchants(id),

    source_product_id uuid NOT NULL
        REFERENCES tbl_products(id),

    buyer_product_id uuid NOT NULL
        REFERENCES tbl_products(id),

    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT tbl_b2b_product_links_merchants_different_check
        CHECK (seller_merchant_id <> buyer_merchant_id),

    CONSTRAINT tbl_b2b_product_links_source_buyer_unique
        UNIQUE (
            buyer_merchant_id,
            source_product_id
        ),

    CONSTRAINT tbl_b2b_product_links_buyer_product_unique
        UNIQUE (
            buyer_merchant_id,
            buyer_product_id
        )
);

CREATE INDEX IF NOT EXISTS idx_b2b_orders_buyer_status
    ON tbl_b2b_orders (
        buyer_merchant_id,
        status,
        created_at DESC
    );

CREATE INDEX IF NOT EXISTS idx_b2b_orders_seller_status
    ON tbl_b2b_orders (
        seller_merchant_id,
        status,
        created_at DESC
    );

CREATE INDEX IF NOT EXISTS idx_b2b_order_items_order
    ON tbl_b2b_order_items (
        b2b_order_id
    );

CREATE INDEX IF NOT EXISTS idx_b2b_product_links_source
    ON tbl_b2b_product_links (
        source_product_id
    );

COMMIT;
