BEGIN;

CREATE TABLE IF NOT EXISTS tbl_market_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    market_order_id uuid NOT NULL
        REFERENCES tbl_market_orders(id),

    payment_method varchar(50) NOT NULL,

    payment_status varchar(20) NOT NULL
        DEFAULT 'UNPAID',

    amount numeric(14,2) NOT NULL,

    provider varchar(50),

    channel varchar(50),

    external_transaction_id varchar(150),

    gateway_response jsonb,

    expires_at timestamptz,

    created_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    updated_at timestamptz NOT NULL
        DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT tbl_market_payments_status_check
        CHECK (
            payment_status IN (
                'UNPAID',
                'PAID',
                'FAILED',
                'EXPIRED',
                'CANCELLED',
                'REFUNDED'
            )
        ),

    CONSTRAINT tbl_market_payments_amount_check
        CHECK (amount >= 0)
);

CREATE INDEX IF NOT EXISTS
    idx_market_payments_market_order
ON tbl_market_payments(market_order_id);

CREATE INDEX IF NOT EXISTS
    idx_market_payments_status
ON tbl_market_payments(payment_status);

COMMIT;
