CREATE TABLE IF NOT EXISTS tbl_market_payment_refunds (
    id uuid PRIMARY KEY
        DEFAULT gen_random_uuid(),

    market_payment_id uuid NOT NULL
        REFERENCES tbl_market_payments(id),

    market_order_id uuid NOT NULL
        REFERENCES tbl_market_orders(id),

    amount numeric NOT NULL
        CHECK (amount > 0),

    status varchar NOT NULL
        DEFAULT 'PENDING'
        CHECK (
            status IN (
                'PENDING',
                'PROCESSING',
                'COMPLETED',
                'FAILED'
            )
        ),

    reason_code varchar NOT NULL,

    reason text NOT NULL,

    provider varchar,

    refund_key varchar NOT NULL,

    external_refund_id varchar,

    requested_by uuid
        REFERENCES tbl_users(id),

    requested_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    completed_at timestamptz,

    provider_response jsonb,

    last_error text,

    created_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    updated_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_market_payment_refund_payment
        UNIQUE (market_payment_id),

    CONSTRAINT uq_market_payment_refund_key
        UNIQUE (refund_key)
);

CREATE INDEX IF NOT EXISTS
    idx_market_payment_refunds_order
ON tbl_market_payment_refunds (
    market_order_id
);

CREATE INDEX IF NOT EXISTS
    idx_market_payment_refunds_status
ON tbl_market_payment_refunds (
    status
);
