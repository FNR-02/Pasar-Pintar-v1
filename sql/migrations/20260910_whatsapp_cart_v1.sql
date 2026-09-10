BEGIN;

CREATE TABLE IF NOT EXISTS tbl_whatsapp_carts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    customer_id uuid NOT NULL
        REFERENCES tbl_customers(id)
        ON DELETE CASCADE,

    status varchar(32) NOT NULL
        DEFAULT 'ACTIVE',

    conversation_language varchar(32),

    fulfillment_type varchar(20),

    payment_preference varchar(32),

    shipping_address text,

    pickup_location_snapshot text,

    source_message_id varchar(128),

    created_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    updated_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    expires_at timestamptz NOT NULL
        DEFAULT (CURRENT_TIMESTAMP + interval '30 minutes'),

    confirmed_at timestamptz,

    CHECK (
        status IN (
            'ACTIVE',
            'CONFIRMED',
            'CANCELLED',
            'EXPIRED'
        )
    ),

    CHECK (
        fulfillment_type IS NULL
        OR fulfillment_type IN (
            'DELIVERY',
            'PICKUP'
        )
    ),

    CHECK (
        payment_preference IS NULL
        OR payment_preference IN (
            'ONLINE',
            'OUTLET'
        )
    ),

    CHECK (
        NOT (
            fulfillment_type = 'DELIVERY'
            AND payment_preference = 'OUTLET'
        )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS
    uq_whatsapp_carts_one_active_per_customer
ON tbl_whatsapp_carts(customer_id)
WHERE status = 'ACTIVE';


CREATE TABLE IF NOT EXISTS tbl_whatsapp_cart_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    cart_id uuid NOT NULL
        REFERENCES tbl_whatsapp_carts(id)
        ON DELETE CASCADE,

    product_id uuid NOT NULL
        REFERENCES tbl_products(id),

    quantity integer NOT NULL,

    unit_price_snapshot numeric(14,2) NOT NULL,

    selling_unit_snapshot varchar(30) NOT NULL
        DEFAULT 'PCS',

    pack_size_value_snapshot numeric(12,3),

    pack_size_unit_snapshot varchar(20),

    available_stock_snapshot integer NOT NULL,

    source_message_id varchar(128),

    created_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    updated_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    CHECK (
        quantity > 0
        AND quantity <= 100
    ),

    CHECK (
        unit_price_snapshot >= 0
    ),

    CHECK (
        available_stock_snapshot >= 0
    ),

    CHECK (
        selling_unit_snapshot IN (
            'PCS',
            'PACK',
            'BUNGKUS',
            'IKAT',
            'BOTOL',
            'DUS',
            'KARUNG',
            'SACHET',
            'KALENG',
            'TRAY',
            'PAPAN'
        )
    ),

    CHECK (
        (
            pack_size_value_snapshot IS NULL
            AND pack_size_unit_snapshot IS NULL
        )
        OR
        (
            pack_size_value_snapshot IS NOT NULL
            AND pack_size_unit_snapshot IS NOT NULL
        )
    ),

    CHECK (
        pack_size_value_snapshot IS NULL
        OR pack_size_value_snapshot > 0
    ),

    CHECK (
        pack_size_unit_snapshot IS NULL
        OR pack_size_unit_snapshot IN (
            'GRAM',
            'KG',
            'ML',
            'LITER',
            'PCS'
        )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS
    uq_whatsapp_cart_items_product
ON tbl_whatsapp_cart_items(
    cart_id,
    product_id
);

CREATE INDEX IF NOT EXISTS
    idx_whatsapp_cart_items_cart
ON tbl_whatsapp_cart_items(cart_id);

COMMIT;
