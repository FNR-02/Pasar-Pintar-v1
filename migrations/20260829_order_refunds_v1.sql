CREATE TABLE IF NOT EXISTS tbl_order_refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    order_id UUID NOT NULL
        REFERENCES tbl_orders_v2(id),

    payment_id UUID NOT NULL
        REFERENCES tbl_payments(id),

    amount NUMERIC NOT NULL
        CHECK (amount > 0),

    status VARCHAR(32) NOT NULL DEFAULT 'PENDING'
        CHECK (
            status IN (
                'PENDING',
                'PROCESSING',
                'COMPLETED',
                'FAILED'
            )
        ),

    reason TEXT NOT NULL,

    provider VARCHAR(64),
    external_refund_id VARCHAR(255),

    requested_by UUID NOT NULL
        REFERENCES tbl_users(id),

    requested_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    completed_at TIMESTAMPTZ,

    provider_response JSONB,

    last_error TEXT,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_order_refund_order
        UNIQUE (order_id),

    CONSTRAINT uq_order_refund_payment
        UNIQUE (payment_id)
);

CREATE INDEX IF NOT EXISTS idx_order_refunds_status
ON tbl_order_refunds (status, created_at);
