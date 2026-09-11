BEGIN;

CREATE TABLE IF NOT EXISTS tbl_whatsapp_cart_operations (
    id uuid PRIMARY KEY
        DEFAULT gen_random_uuid(),

    cart_id uuid NOT NULL
        REFERENCES tbl_whatsapp_carts(id)
        ON DELETE CASCADE,

    customer_id uuid NOT NULL
        REFERENCES tbl_customers(id)
        ON DELETE CASCADE,

    source_message_id varchar(128) NOT NULL,

    operation_index integer NOT NULL,

    operation_type varchar(40) NOT NULL,

    status varchar(20) NOT NULL
        DEFAULT 'CLAIMED',

    created_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    completed_at timestamptz,

    CHECK (
        operation_index >= 0
    ),

    CHECK (
        status IN (
            'CLAIMED',
            'COMPLETED'
        )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS
    uq_whatsapp_cart_operations_message
ON tbl_whatsapp_cart_operations (
    customer_id,
    source_message_id,
    operation_index
);

CREATE INDEX IF NOT EXISTS
    idx_whatsapp_cart_operations_cart
ON tbl_whatsapp_cart_operations (
    cart_id
);

COMMIT;
